"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeScriptHandler = void 0;
const base_1 = require("./base");
const ts = __importStar(require("typescript"));
class TypeScriptHandler extends base_1.BaseLanguageHandler {
    constructor() {
        super(...arguments);
        this.fileExtensions = ['.ts', '.tsx'];
        this.languageId = 'typescript';
        this.importPatterns = [
            /import\s+(?:(?:\*\s+as\s+\w+)|(?:{\s*[\w\s,]+\s*})|(?:[\w]+))?\s*from\s*['"]([^'"]+)['"]/g,
            /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
        ];
        this.functionPatterns = [
            /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*<[^>]*>?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\s*{/g,
            /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*([^=]+))?\s*=>/g,
            /(?:export\s+)?(?:abstract\s+)?class\s+\w+\s*{[^}]*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\s*{/g
        ];
        this.classPatterns = [
            /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+(?:\w+(?:\s*,\s*\w+)*)?)?\s*{/g
        ];
        this.blockPatterns = [
            /{[^{}]*}/g,
            /\([^()]*\)/g,
            /\[[^\[\]]*\]/g
        ];
        this.compilerOptions = {
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.ESNext,
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true
        };
    }
    parseImport(match) {
        return match[1];
    }
    parseFunction(match) {
        const [_, name, params = '', returnType = ''] = match;
        return {
            name,
            params: params.split(',').map(p => p.trim()).filter(Boolean),
            returnType: returnType.trim() || undefined
        };
    }
    analyzeDependencies(content) {
        const sourceFile = ts.createSourceFile('temp.ts', content, ts.ScriptTarget.Latest, true);
        const dependencies = new Set();
        const visit = (node) => {
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
                const moduleSpecifier = node.moduleSpecifier;
                if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
                    dependencies.add(moduleSpecifier.text);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return Array.from(dependencies);
    }
    analyzeFunctions(content) {
        const sourceFile = ts.createSourceFile('temp.ts', content, ts.ScriptTarget.Latest, true);
        const functions = [];
        const visit = (node) => {
            if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
                const name = node.name?.getText(sourceFile) || 'anonymous';
                const params = node.parameters.map(p => p.getText(sourceFile));
                const returnType = node.type?.getText(sourceFile);
                const complexity = this.calculateComplexity(node);
                functions.push({ name, params, returnType, complexity });
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return functions;
    }
    calculateComplexity(node) {
        let complexity = 1;
        const visit = (node) => {
            if (ts.isIfStatement(node) ||
                ts.isForStatement(node) ||
                ts.isWhileStatement(node) ||
                ts.isDoStatement(node) ||
                ts.isCaseClause(node) ||
                ts.isConditionalExpression(node)) {
                complexity++;
            }
            ts.forEachChild(node, visit);
        };
        visit(node);
        return complexity;
    }
    analyzeStructure(content) {
        const sourceFile = ts.createSourceFile('temp.ts', content, ts.ScriptTarget.Latest, true);
        const structures = [];
        const visit = (node) => {
            let type = 'other';
            let name = '';
            if (ts.isClassDeclaration(node)) {
                type = 'class';
                name = node.name?.getText(sourceFile) || 'anonymous';
            }
            else if (ts.isFunctionDeclaration(node)) {
                type = 'function';
                name = node.name?.getText(sourceFile) || 'anonymous';
            }
            else if (ts.isInterfaceDeclaration(node)) {
                type = 'interface';
                name = node.name.getText(sourceFile);
            }
            else if (ts.isVariableStatement(node)) {
                type = 'variable';
                name = node.declarationList.declarations[0].name.getText(sourceFile);
            }
            if (type !== 'other') {
                const { line: startLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart());
                const { line: endLine } = ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd());
                structures.push({ type, name, startLine, endLine });
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return structures;
    }
    detectSyntaxErrors(content) {
        const program = ts.createProgram(['temp.ts'], this.compilerOptions, {
            getSourceFile: (fileName) => {
                return fileName === 'temp.ts'
                    ? ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest)
                    : undefined;
            },
            writeFile: () => { },
            getCurrentDirectory: () => '/',
            getDirectories: () => [],
            getCanonicalFileName: (fileName) => fileName,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            getDefaultLibFileName: () => 'lib.d.ts',
            fileExists: () => true,
            readFile: () => '',
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        return diagnostics.map(diagnostic => {
            const { line, character } = diagnostic.file
                ? ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
                : { line: 0, character: 0 };
            return {
                line,
                column: character,
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
            };
        });
    }
    generateImports(dependencies) {
        return dependencies
            .map(dep => `import * as ${this.generateImportName(dep)} from '${dep}';`)
            .join('\n');
    }
    generateImportName(dependency) {
        return dependency
            .split('/')
            .pop()
            .replace(/[^a-zA-Z0-9]/g, '')
            .replace(/^(\d)/, '_$1');
    }
    generateFunction(name, params, returnType, body) {
        const paramsList = params.map(p => `${p}: any`).join(', ');
        return `function ${name}(${paramsList})${returnType ? `: ${returnType}` : ''} {\n${body}\n}`;
    }
    generateClass(name, properties, methods) {
        const props = properties.map(p => `    ${p}: any;`).join('\n');
        const meths = methods.map(m => `    ${m}`).join('\n\n');
        return `class ${name} {\n${props}\n\n${meths}\n}`;
    }
    validateSyntax(content) {
        return this.detectSyntaxErrors(content).length === 0;
    }
    validateImports(content) {
        const imports = this.analyzeImports(content);
        const sourceFile = ts.createSourceFile('temp.ts', content, ts.ScriptTarget.Latest, true);
        // Check if all imports are properly used
        const identifiers = new Set();
        const visit = (node) => {
            if (ts.isIdentifier(node)) {
                identifiers.add(node.getText());
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return imports.every(imp => {
            const importName = this.generateImportName(imp);
            return identifiers.has(importName);
        });
    }
    validateStructure(content) {
        const sourceFile = ts.createSourceFile('temp.ts', content, ts.ScriptTarget.Latest, true);
        let isValid = true;
        const visit = (node) => {
            if (ts.isClassDeclaration(node)) {
                // Check if class has constructor
                const hasConstructor = node.members.some(m => ts.isConstructorDeclaration(m));
                if (!hasConstructor) {
                    isValid = false;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return isValid;
    }
    formatCode(content) {
        const sourceFile = ts.createSourceFile('temp.ts', content, ts.ScriptTarget.Latest, true);
        const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
        return printer.printFile(sourceFile);
    }
    injectImports(content, imports) {
        const sourceFile = ts.createSourceFile('temp.ts', content, ts.ScriptTarget.Latest, true);
        const existingImports = new Set(this.analyzeImports(content));
        const newImports = imports.filter(imp => !existingImports.has(imp));
        if (newImports.length === 0) {
            return content;
        }
        const importStatements = this.generateImports(newImports);
        return importStatements + '\n\n' + content;
    }
    wrapInFunction(content, functionName) {
        return `function ${functionName}() {\n${content}\n}`;
    }
}
exports.TypeScriptHandler = TypeScriptHandler;
//# sourceMappingURL=typescript.js.map