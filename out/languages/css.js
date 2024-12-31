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
exports.CSSHandler = void 0;
const base_1 = require("./base");
const cssTree = __importStar(require("css-tree"));
class CSSHandler extends base_1.BaseLanguageHandler {
    constructor() {
        super(...arguments);
        this.fileExtensions = ['.css', '.scss', '.less'];
        this.languageId = 'css';
        this.importPatterns = [
            /@import\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?/g,
            /@use\s+['"]([^'"]+)['"]/g
        ];
        this.functionPatterns = [
            /@mixin\s+(\w+)\s*\(([^)]*)\)/g,
            /@function\s+(\w+)\s*\(([^)]*)\)/g
        ];
        this.classPatterns = [
            /\.[\w-]+\s*{/g
        ];
        this.blockPatterns = [
            /{[^{}]*}/g
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
            const ast = cssTree.parse(content);
            cssTree.walk(ast, {
                visit: 'Atrule',
                enter: (node) => {
                    if (node.name === 'import' || node.name === 'use') {
                        const stringNode = node.prelude.children.first();
                        if (stringNode && stringNode.type === 'String') {
                            dependencies.add(stringNode.value.slice(1, -1));
                        }
                    }
                }
            });
        }
        catch (error) {
            console.error('Error parsing CSS:', error);
        }
        return Array.from(dependencies);
    }
    analyzeFunctions(content) {
        const functions = [];
        try {
            const ast = cssTree.parse(content, {
                context: 'stylesheet'
            });
            cssTree.walk(ast, {
                visit: 'Atrule',
                enter: (node) => {
                    if (node.name === 'mixin' || node.name === 'function') {
                        const name = node.prelude.children.first().name;
                        const params = node.prelude.children
                            .filter((child) => child.type === 'Declaration')
                            .map((child) => child.property);
                        functions.push({
                            name,
                            params,
                            complexity: this.calculateComplexity(node)
                        });
                    }
                }
            });
        }
        catch (error) {
            console.error('Error parsing CSS:', error);
        }
        return functions;
    }
    calculateComplexity(node) {
        let complexity = 1;
        cssTree.walk(node, {
            visit: 'Rule',
            enter: () => complexity++
        });
        return complexity;
    }
    analyzeStructure(content) {
        const structures = [];
        try {
            const ast = cssTree.parse(content);
            cssTree.walk(ast, {
                visit: 'Rule',
                enter: (node) => {
                    if (node.prelude.type === 'SelectorList') {
                        const selector = cssTree.generate(node.prelude);
                        const lines = content.slice(0, node.loc.start.offset).split('\n');
                        const startLine = lines.length - 1;
                        const endLine = content.slice(0, node.loc.end.offset).split('\n').length - 1;
                        structures.push({
                            type: selector.startsWith('.') ? 'class' : 'other',
                            name: selector,
                            startLine,
                            endLine
                        });
                    }
                }
            });
        }
        catch (error) {
            console.error('Error parsing CSS:', error);
        }
        return structures;
    }
    detectSyntaxErrors(content) {
        const errors = [];
        try {
            cssTree.parse(content, {
                onParseError: (error) => {
                    errors.push({
                        line: error.line - 1,
                        column: error.column - 1,
                        message: error.message
                    });
                }
            });
        }
        catch (error) {
            if (error.line && error.column) {
                errors.push({
                    line: error.line - 1,
                    column: error.column - 1,
                    message: error.message
                });
            }
        }
        return errors;
    }
    generateImports(dependencies) {
        return dependencies
            .map(dep => `@import '${dep}';`)
            .join('\n');
    }
    generateFunction(name, params, returnType, body) {
        const paramsList = params.join(', ');
        return `@mixin ${name}(${paramsList}) {\n${this.indentCode(body)}\n}`;
    }
    generateClass(name, properties, methods) {
        const props = properties.map(p => `    ${p};`).join('\n');
        return `.${name} {\n${props}\n}`;
    }
    indentCode(code, spaces = 4) {
        return code.split('\n')
            .map(line => ' '.repeat(spaces) + line)
            .join('\n');
    }
    validateSyntax(content) {
        try {
            cssTree.parse(content);
            return true;
        }
        catch (error) {
            return false;
        }
    }
    validateImports(content) {
        const imports = this.analyzeImports(content);
        // Check if imports are at the top of the file
        const lines = content.split('\n');
        let foundRuleBeforeImport = false;
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '' || trimmedLine.startsWith('/*'))
                continue;
            if (!trimmedLine.startsWith('@import') && !trimmedLine.startsWith('@use')) {
                foundRuleBeforeImport = true;
            }
            else if (foundRuleBeforeImport) {
                return false;
            }
        }
        return true;
    }
    validateStructure(content) {
        try {
            const ast = cssTree.parse(content);
            let hasValidStructure = true;
            cssTree.walk(ast, {
                visit: 'Rule',
                enter: (node) => {
                    // Check for nested selectors (not allowed in standard CSS)
                    if (node.block.children.some((child) => child.type === 'Rule')) {
                        hasValidStructure = false;
                    }
                }
            });
            return hasValidStructure;
        }
        catch (error) {
            return false;
        }
    }
    formatCode(content) {
        try {
            const ast = cssTree.parse(content);
            return cssTree.generate(ast, {
                sourceMap: false
            });
        }
        catch (error) {
            return content;
        }
    }
    injectImports(content, imports) {
        const existingImports = this.analyzeImports(content);
        const newImports = imports.filter(imp => !existingImports.includes(imp));
        if (newImports.length === 0) {
            return content;
        }
        const importStatements = this.generateImports(newImports);
        // Find the last import statement in the file
        const lines = content.split('\n');
        let lastImportIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('@import') || line.startsWith('@use')) {
                lastImportIndex = i;
            }
            else if (line !== '' && !line.startsWith('/*')) {
                break;
            }
        }
        if (lastImportIndex === -1) {
            return importStatements + '\n\n' + content;
        }
        else {
            lines.splice(lastImportIndex + 1, 0, importStatements);
            return lines.join('\n');
        }
    }
    wrapInFunction(content, functionName) {
        return `@mixin ${functionName} {\n${this.indentCode(content)}\n}`;
    }
}
exports.CSSHandler = CSSHandler;
//# sourceMappingURL=css.js.map