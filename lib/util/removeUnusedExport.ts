import ts from 'typescript';
import { FileService } from './FileService.js';
import { applyTextChanges } from './applyTextChanges.js';
import {
  applyCodeFix,
  fixIdDelete,
  fixIdDeleteImports,
} from './applyCodeFix.js';
import { EditTracker } from './EditTracker.js';

const findFirstNodeOfKind = (root: ts.Node, kind: ts.SyntaxKind) => {
  let result: ts.Node | undefined;
  const visitor = (node: ts.Node) => {
    if (result) {
      return;
    }

    if (node.kind === kind) {
      result = node;
      return;
    }
    ts.forEachChild(node, visitor);
  };

  ts.forEachChild(root, visitor);

  return result;
};

const IGNORE_COMMENT = 'ts-remove-unused-skip';

const getLeadingComment = (node: ts.Node) => {
  const sourceFile = node.getSourceFile();
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());

  if (!ranges) {
    return '';
  }

  return ranges.map((range) => fullText.slice(range.pos, range.end)).join('');
};

type SupportedNode =
  | ts.VariableStatement
  | ts.FunctionDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.ExportAssignment
  | ts.ExportSpecifier
  | ts.ClassDeclaration;

const isTarget = (node: ts.Node): node is SupportedNode => {
  if (ts.isExportAssignment(node) || ts.isExportSpecifier(node)) {
    return true;
  }

  if (
    ts.isVariableStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    const hasExportKeyword = !!findFirstNodeOfKind(
      node,
      ts.SyntaxKind.ExportKeyword,
    );

    if (!hasExportKeyword) {
      return false;
    }

    return true;
  }

  return false;
};

const findReferences = (node: SupportedNode, service: ts.LanguageService) => {
  if (ts.isVariableStatement(node)) {
    const variableDeclaration = findFirstNodeOfKind(
      node,
      ts.SyntaxKind.VariableDeclaration,
    );

    if (!variableDeclaration) {
      return undefined;
    }

    const references = service.findReferences(
      node.getSourceFile().fileName,
      variableDeclaration.getStart(),
    );

    return references;
  }

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isExportSpecifier(node) ||
    ts.isClassDeclaration(node)
  ) {
    return service.findReferences(
      node.getSourceFile().fileName,
      node.getStart(),
    );
  }

  if (ts.isExportAssignment(node)) {
    const defaultKeyword = node
      .getChildren()
      .find((n) => n.kind === ts.SyntaxKind.DefaultKeyword);

    if (!defaultKeyword) {
      return undefined;
    }

    return service.findReferences(
      node.getSourceFile().fileName,
      defaultKeyword.getStart(),
    );
  }

  throw new Error(`unexpected node type: ${node satisfies never}`);
};

const getReexportInFile = (file: ts.SourceFile) => {
  const result: ts.ExportSpecifier[] = [];

  // todo: consider pruning for performance
  const visit = (node: ts.Node) => {
    if (ts.isExportSpecifier(node)) {
      if (
        node.parent.parent.moduleSpecifier &&
        ts.isStringLiteral(node.parent.parent.moduleSpecifier)
      ) {
        result.push(node);
      }

      return;
    }

    node.forEachChild(visit);
  };

  file.forEachChild(visit);

  return result;
};

const getFileFromModuleSpecifierText = ({
  specifier,
  fileName,
  program,
  fileService,
}: {
  specifier: string;
  fileName: string;
  program: ts.Program;
  fileService: FileService;
}) =>
  ts.resolveModuleName(specifier, fileName, program.getCompilerOptions(), {
    fileExists(fileName) {
      return fileService.exists(fileName);
    },
    readFile(fileName) {
      return fileService.get(fileName);
    },
  }).resolvedModule?.resolvedFileName;

const getAncestorFiles = (
  node: ts.ExportSpecifier,
  references: ts.ReferencedSymbol[],
  fileService: FileService,
  program: ts.Program,
  fileName: string,
) => {
  const result = new Set<string>();
  const referencesKeyValue = Object.fromEntries(
    references.map((v) => [v.definition.fileName, v]),
  );

  if (
    !node.parent.parent.moduleSpecifier ||
    !ts.isStringLiteral(node.parent.parent.moduleSpecifier)
  ) {
    return null;
  }

  let specifier: string | null = node.parent.parent.moduleSpecifier.text;
  let currentFile = fileName;

  while (specifier) {
    const origin = getFileFromModuleSpecifierText({
      specifier,
      fileName: currentFile,
      program,
      fileService,
    });

    if (!origin) {
      return null;
    }

    result.add(origin);

    const referencedSymbol = referencesKeyValue[origin];

    if (!referencedSymbol) {
      return null;
    }

    const sourceFile = program.getSourceFile(origin);

    if (!sourceFile) {
      return null;
    }

    const reexportSpecifiers = getReexportInFile(sourceFile);
    const firstReferencedSymbol = referencedSymbol.references[0];
    const reexportNode = firstReferencedSymbol
      ? reexportSpecifiers.find((r) => {
          const start = firstReferencedSymbol.textSpan.start;
          const end = start + firstReferencedSymbol.textSpan.length;

          return r.getStart() === start && r.getEnd() === end;
        })
      : undefined;

    if (reexportNode) {
      if (
        !reexportNode.parent.parent.moduleSpecifier ||
        !ts.isStringLiteral(reexportNode.parent.parent.moduleSpecifier)
      ) {
        // type guard: should not happen
        throw new Error('unexpected reexportNode');
      }

      specifier = reexportNode.parent.parent.moduleSpecifier.text;
      currentFile = origin;
    } else {
      specifier = null;
    }
  }
  return result;
};

const getUnusedExports = (
  languageService: ts.LanguageService,
  sourceFile: ts.SourceFile,
  fileService: FileService,
) => {
  const { fileName } = sourceFile;
  const nodes: SupportedNode[] = [];
  let isUsed = false;

  const program = languageService.getProgram();

  if (!program) {
    throw new Error('program not found');
  }

  const visit = (node: ts.Node) => {
    if (ts.isExportDeclaration(node) && !node.exportClause) {
      // special case for `export * from './foo';`
      isUsed = true;
      return;
    }

    if (isTarget(node)) {
      if (getLeadingComment(node).includes(IGNORE_COMMENT)) {
        isUsed = true;
        return;
      }

      const references = findReferences(node, languageService);

      if (!references) {
        return;
      }

      // reexport syntax: `export { foo } from './bar';`
      if (ts.isExportSpecifier(node) && node.parent.parent.moduleSpecifier) {
        const ancestors = getAncestorFiles(
          node,
          references,
          fileService,
          program,
          fileName,
        );

        if (!ancestors) {
          isUsed = true;
          return;
        }

        const count = references
          .filter(
            (v) =>
              v.definition.fileName !== fileName &&
              !ancestors.has(v.definition.fileName),
          )
          .flatMap((v) => v.references).length;

        if (count > 0) {
          isUsed = true;
        } else {
          nodes.push(node);
        }

        return;
      }

      const count = references
        .filter((v) => v.definition.fileName !== fileName)
        .flatMap((v) => v.references).length;

      if (count > 0) {
        isUsed = true;
      } else {
        nodes.push(node);
      }

      return;
    }

    node.forEachChild(visit);
  };

  sourceFile.forEachChild(visit);

  return { nodes, isUsed };
};

const getUpdatedExportDeclaration = (
  exportDeclaration: ts.ExportDeclaration,
  removeTarget: ts.ExportSpecifier,
) => {
  const tmpFile = ts.createSourceFile(
    'tmp.ts',
    exportDeclaration.getText(),
    exportDeclaration.getSourceFile().languageVersion,
  );

  const transformer: ts.TransformerFactory<ts.SourceFile> =
    (context: ts.TransformationContext) => (rootNode: ts.SourceFile) => {
      const visitor = (node: ts.Node): ts.Node | undefined => {
        if (
          ts.isExportSpecifier(node) &&
          node.getText(tmpFile) === removeTarget.getText()
        ) {
          return undefined;
        }
        return ts.visitEachChild(node, visitor, context);
      };

      return ts.visitEachChild(rootNode, visitor, context);
    };

  const result = ts.transform(tmpFile, [transformer]).transformed[0];

  const printer = ts.createPrinter();

  return result ? printer.printFile(result).trim() : '';
};

const getTextChanges = (
  languageService: ts.LanguageService,
  file: string,
  editTracker: EditTracker,
  fileService: FileService,
) => {
  const sourceFile = languageService.getProgram()?.getSourceFile(file);

  if (!sourceFile) {
    throw new Error('source file not found');
  }

  const changes: ts.TextChange[] = [];
  // usually we want to remove all unused exports in one pass, but there are some cases where we need to do multiple passes
  // for example, when we have multiple export specifiers in one export declaration, we want to remove them one by one because the text change range will conflict
  let aborted = false;

  const { nodes, isUsed } = getUnusedExports(
    languageService,
    sourceFile,
    fileService,
  );
  for (const node of nodes) {
    if (aborted === true) {
      break;
    }

    if (ts.isExportSpecifier(node)) {
      const specifierCount = Array.from(node.parent.elements).length;

      if (specifierCount === 1) {
        // special case: if the export specifier is the only specifier in the export declaration, we want to remove the whole export declaration
        changes.push({
          newText: '',
          span: {
            start: node.parent.parent.getFullStart(),
            length: node.parent.parent.getFullWidth(),
          },
        });

        editTracker.removeExport(sourceFile.fileName, {
          position: node.parent.parent.getStart(),
          code: node.parent.parent.getText(),
        });

        continue;
      }

      aborted = true;
      changes.push({
        newText: getUpdatedExportDeclaration(node.parent.parent, node),
        span: {
          start: node.parent.parent.getStart(),
          length: node.parent.parent.getWidth(),
        },
      });

      const from = node.parent.parent.moduleSpecifier
        ? ` from ${node.parent.parent.moduleSpecifier.getText()}`
        : '';

      editTracker.removeExport(sourceFile.fileName, {
        position: node.getStart(),
        code: `export { ${node.getText()} }${from};`,
      });

      continue;
    }

    if (ts.isExportAssignment(node)) {
      changes.push({
        newText: '',
        span: {
          start: node.getFullStart(),
          length: node.getFullWidth(),
        },
      });

      editTracker.removeExport(sourceFile.fileName, {
        position: node.getStart(),
        code: node.getText(),
      });
      continue;
    }

    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      const identifier = node
        .getChildren()
        .find((n) => n.kind === ts.SyntaxKind.Identifier);

      // when the identifier is not found, it's likely a default export of an unnamed function/class declaration.
      // in this case, we want to remove the whole declaration
      if (!identifier) {
        changes.push({
          newText: '',
          span: {
            start: node.getFullStart(),
            length: node.getFullWidth(),
          },
        });

        // there's no identifier so we try to get something like `export default function()` or `export default class`
        const code = node
          .getText()
          .slice(
            0,
            ts.isFunctionDeclaration(node)
              ? node.getText().indexOf(')') + 1
              : node.getText().indexOf('{') - 1,
          );

        editTracker.removeExport(sourceFile.fileName, {
          position: node.getStart(),
          code,
        });

        continue;
      }
    }

    // we want to correctly remove 'default' when its a default export so we get the syntaxList node instead of the exportKeyword node
    // note: the first syntaxList node should contain the export keyword
    const syntaxListIndex = node
      .getChildren()
      .findIndex((n) => n.kind === ts.SyntaxKind.SyntaxList);

    const syntaxList = node.getChildren()[syntaxListIndex];
    const syntaxListNextSibling = node.getChildren()[syntaxListIndex + 1];

    if (!syntaxList || !syntaxListNextSibling) {
      throw new Error('syntax list not found');
    }

    changes.push({
      newText: '',
      span: {
        start: syntaxList.getStart(),
        length: syntaxListNextSibling.getStart() - syntaxList.getStart(),
      },
    });

    editTracker.removeExport(sourceFile.fileName, {
      position: node.getStart(),
      code:
        findFirstNodeOfKind(node, ts.SyntaxKind.Identifier)?.getText() || '',
    });
  }

  return { changes, done: !aborted, isUsed };
};

const disabledEditTracker: EditTracker = {
  start: () => {},
  end: () => {},
  delete: () => {},
  removeExport: () => {},
};

export const removeUnusedExport = ({
  fileService,
  targetFile,
  languageService,
  deleteUnusedFile = false,
  enableCodeFix = false,
  editTracker = disabledEditTracker,
}: {
  fileService: FileService;
  targetFile: string | string[];
  languageService: ts.LanguageService;
  enableCodeFix?: boolean;
  deleteUnusedFile?: boolean;
  editTracker?: EditTracker;
}) => {
  const program = languageService.getProgram();

  if (!program) {
    throw new Error('program not found');
  }

  for (const file of Array.isArray(targetFile) ? targetFile : [targetFile]) {
    const sourceFile = program.getSourceFile(file);

    if (!sourceFile) {
      continue;
    }

    editTracker.start(file, sourceFile.getFullText());

    let content = fileService.get(file);
    let isUsed = false;

    do {
      const result = getTextChanges(
        languageService,
        file,
        editTracker,
        fileService,
      );

      isUsed = result.isUsed;

      content = applyTextChanges(content, result.changes);

      fileService.set(file, content);

      if (result.done) {
        break;
      }
      // eslint-disable-next-line no-constant-condition
    } while (true);

    if (!isUsed && deleteUnusedFile) {
      fileService.delete(file);
      editTracker.delete(file);

      continue;
    }

    editTracker.end(file);

    if (enableCodeFix) {
      while (true) {
        fileService.set(file, content);

        const result = applyCodeFix({
          fixId: fixIdDelete,
          fileName: file,
          languageService,
        });

        if (result === content) {
          break;
        }

        content = result;
      }

      fileService.set(file, content);

      content = applyCodeFix({
        fixId: fixIdDeleteImports,
        fileName: file,
        languageService,
      });
    }

    fileService.set(file, content);
  }
};
