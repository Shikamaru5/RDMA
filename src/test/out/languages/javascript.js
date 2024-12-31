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
exports.JavaScriptHandler = void 0;
const base_1 = require("./base");
const acorn = __importStar(require("acorn"));
const walk = __importStar(require("acorn-walk"));
class JavaScriptHandler extends base_1.BaseLanguageHandler {
    constructor() {
        super(...arguments);
        this.fileExtensions = ['.js', '.jsx', '.mjs'];
        this.languageId = 'javascript';
        this.importPatterns = [
            /import\s+(?:(?:\*\s+as\s+\w+)|(?:{\s*[\w\s,]+\s*})|(?:[\w]+))?\s*from\s*['"]([^'"]+)['"]/g,
            /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
        ];
        this.functionPatterns = [
            /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*{/g,
            /(?:async\s+)?(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/g,
            /(\w+)\s*:\s*(?:async\s+)?function\s*\([^)]*\)/g
        ];
        this.classPatterns = [
            /class\s+(\w+)(?:\s+extends\s+\w+)?\s*{/g
        ];
        this.blockPatterns = [
            /{[^{}]*}/g,
            /\([^()]*\)/g,
            /\[[^\[\]]*\]/g
        ];
    }
    parseImport(match) {
        return match[1];
    }
    parseFunction(match) {
        const [_, name, params = ''] = match;
        return {
            name,
            params: params.split(',').map(p => p.trim()).filter(Boolean)
        };
    }
    analyzeDependencies(content) {
        const dependencies = new Set();
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });
            walk.simple(ast, {
                ImportDeclaration(node) {
                    dependencies.add(node.source.value);
                },
                CallExpression(node) {
                    if (node.callee.name === 'require' &&
                        node.arguments.length > 0 &&
                        node.arguments[0].type === 'Literal') {
                        dependencies.add(node.arguments[0].value);
                    }
                }
            });
        }
        catch (error) {
            console.error('Error parsing JavaScript:', error);
        }
        return Array.from(dependencies);
    }
    analyzeFunctions(content) {
        const functions = [];
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });
            const calculateComplexity = (node) => {
                let complexity = 1;
                walk.simple(node, {
                    IfStatement: () => complexity++,
                    ForStatement: () => complexity++,
                    WhileStatement: () => complexity++,
                    DoWhileStatement: () => complexity++,
                    SwitchCase: () => complexity++,
                    LogicalExpression: () => complexity++,
                    ConditionalExpression: () => complexity++
                });
                return complexity;
            };
            walk.simple(ast, {
                FunctionDeclaration(node) {
                    functions.push({
                        name: node.id.name,
                        params: node.params.map((p) => p.name),
                        complexity: calculateComplexity(node)
                    });
                },
                MethodDefinition(node) {
                    if (node.value.type === 'FunctionExpression') {
                        functions.push({
                            name: node.key.name,
                            params: node.value.params.map((p) => p.name),
                            complexity: calculateComplexity(node.value)
                        });
                    }
                },
                VariableDeclarator(node) {
                    if (node.init &&
                        (node.init.type === 'FunctionExpression' ||
                            node.init.type === 'ArrowFunctionExpression')) {
                        functions.push({
                            name: node.id.name,
                            params: node.init.params.map((p) => p.name),
                            complexity: calculateComplexity(node.init)
                        });
                    }
                }
            });
        }
        catch (error) {
            console.error('Error parsing JavaScript:', error);
        }
        return functions;
    }
    analyzeStructure(content) {
        const structures = [];
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest',
                locations: true
            });
            walk.simple(ast, {
                ClassDeclaration(node) {
                    structures.push({
                        type: 'class',
                        name: node.id.name,
                        startLine: node.loc.start.line - 1,
                        endLine: node.loc.end.line - 1
                    });
                },
                FunctionDeclaration(node) {
                    structures.push({
                        type: 'function',
                        name: node.id.name,
                        startLine: node.loc.start.line - 1,
                        endLine: node.loc.end.line - 1
                    });
                },
                VariableDeclaration(node) {
                    node.declarations.forEach((decl) => {
                        structures.push({
                            type: 'variable',
                            name: decl.id.name,
                            startLine: node.loc.start.line - 1,
                            endLine: node.loc.end.line - 1
                        });
                    });
                }
            });
        }
        catch (error) {
            console.error('Error parsing JavaScript:', error);
        }
        return structures;
    }
    detectSyntaxErrors(content) {
        const errors = [];
        try {
            acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest',
                locations: true,
                onError: (error) => {
                    errors.push({
                        line: error.loc.line - 1,
                        column: error.loc.column,
                        message: error.message
                    });
                }
            });
        }
        catch (error) {
            if (error.loc) {
                errors.push({
                    line: error.loc.line - 1,
                    column: error.loc.column,
                    message: error.message
                });
            }
        }
        return errors;
    }
    generateImports(dependencies) {
        return dependencies
            .map(dep => `import ${this.generateImportName(dep)} from '${dep}';`)
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
        const paramsList = params.join(', ');
        return `function ${name}(${paramsList}) {\n${this.indentCode(body)}\n}`;
    }
    generateClass(name, properties, methods) {
        const props = properties.map(p => `    ${p};`).join('\n');
        const meths = methods.map(m => this.indentCode(m)).join('\n\n');
        return `class ${name} {\n${props}\n\n${meths}\n}`;
    }
    indentCode(code, spaces = 4) {
        return code.split('\n')
            .map(line => ' '.repeat(spaces) + line)
            .join('\n');
    }
    validateSyntax(content) {
        return this.detectSyntaxErrors(content).length === 0;
    }
    validateImports(content) {
        const imports = this.analyzeImports(content);
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });
            const usedIdentifiers = new Set();
            walk.simple(ast, {
                Identifier(node) {
                    usedIdentifiers.add(node.name);
                }
            });
            return imports.every(imp => {
                const importName = this.generateImportName(imp);
                return usedIdentifiers.has(importName);
            });
        }
        catch (error) {
            return false;
        }
    }
    validateStructure(content) {
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });
            let hasDefaultExport = false;
            let hasNamedExports = false;
            walk.simple(ast, {
                ExportDefaultDeclaration() {
                    hasDefaultExport = true;
                },
                ExportNamedDeclaration() {
                    hasNamedExports = true;
                }
            });
            // Basic structure validation - at least one export
            return hasDefaultExport || hasNamedExports;
        }
        catch (error) {
            return false;
        }
    }
    formatCode(content) {
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });
            let formatted = '';
            let indentLevel = 0;
            walk.simple(ast, {
                Program: (node) => { indentLevel = 0; },
                BlockStatement: (node) => {
                    if (node.type === 'BlockStatement') {
                        indentLevel++;
                    }
                }
            });
            return formatted;
        }
        catch (error) {
            return content; // Return original if parsing fails
        }
    }
    injectImports(content, imports) {
        const existingImports = this.analyzeImports(content);
        const newImports = imports.filter(imp => !existingImports.includes(imp));
        if (newImports.length === 0) {
            return content;
        }
        const importStatements = this.generateImports(newImports);
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });
            let lastImportIndex = -1;
            walk.simple(ast, {
                ImportDeclaration(node) {
                    lastImportIndex = Math.max(lastImportIndex, node.end);
                }
            });
            if (lastImportIndex === -1) {
                return importStatements + '\n\n' + content;
            }
            else {
                return content.slice(0, lastImportIndex) + '\n' +
                    importStatements + '\n' +
                    content.slice(lastImportIndex);
            }
        }
        catch (error) {
            return importStatements + '\n\n' + content;
        }
    }
    wrapInFunction(content, functionName) {
        return `function ${functionName}() {\n${this.indentCode(content)}\n}`;
    }
}
exports.JavaScriptHandler = JavaScriptHandler;
//# sourceMappingURL=javascript.js.map