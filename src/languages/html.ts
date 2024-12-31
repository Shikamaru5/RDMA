import { BaseLanguageHandler } from './base';
import { parse as parseHTML, HTMLElement, Node } from 'node-html-parser';

export class HTMLHandler extends BaseLanguageHandler {
    readonly fileExtensions = ['.html', '.htm'];
    readonly languageId = 'html';
    readonly importPatterns = [
        /<link\s+[^>]*href=["']([^"']+)["'][^>]*>/g,
        /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g,
        /@import\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?/g
    ];
    readonly dependencyPatterns = [
        /package\.json/g,
        /index\.html/g,
        /styles\.css/g,
        /script\.js/g
    ];
    readonly functionPatterns = [
        /<script[^>]*>\s*function\s+(\w+)\s*\(([^)]*)\)/g,
        /<script[^>]*>\s*const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g
    ];
    readonly classPatterns = [
        /class=["']([^"']+)["']/g
    ];
    readonly blockPatterns = [
        /<[^>]+>/g,
        /{[^{}]*}/g
    ];

    protected parseImport(match: RegExpMatchArray): string {
        return match[1];
    }

    protected parseFunction(match: RegExpMatchArray): { name: string; params: string[]; returnType?: string; } {
        const [_, name, params = ''] = match;
        return {
            name,
            params: params.split(',').map(p => p.trim()).filter(Boolean)
        };
    }

    analyzeDependencies(content: string): string[] {
        const dependencies = new Set<string>();
        
        try {
            const root = parseHTML(content);
            
            // Find CSS dependencies
            root.querySelectorAll('link[rel="stylesheet"]').forEach((link: HTMLElement) => {
                const href = link.getAttribute('href');
                if (href) dependencies.add(href);
            });
            
            // Find JavaScript dependencies
            root.querySelectorAll('script[src]').forEach((script: HTMLElement) => {
                const src = script.getAttribute('src');
                if (src) dependencies.add(src);
            });
            
            // Find image dependencies
            root.querySelectorAll('img[src]').forEach((img: HTMLElement) => {
                const src = img.getAttribute('src');
                if (src) dependencies.add(src);
            });
        } catch (error) {
            console.error('Error parsing HTML:', error);
        }

        return Array.from(dependencies);
    }

    analyzeFunctions(content: string): { name: string; params: string[]; returnType?: string; complexity: number; }[] {
        const functions: { name: string; params: string[]; returnType?: string; complexity: number; }[] = [];
        
        try {
            const root = parseHTML(content);
            
            // Find script tags
            root.querySelectorAll('script').forEach((script: HTMLElement) => {
                const scriptContent = script.text;
                
                // Find function declarations
                const functionMatches = scriptContent.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g);
                for (const match of functionMatches) {
                    const [_, name, params = ''] = match;
                    functions.push({
                        name,
                        params: params.split(',').map((p: string) => p.trim()).filter(Boolean),
                        complexity: this.calculateComplexity(scriptContent)
                    });
                }
                
                // Find arrow functions
                const arrowMatches = scriptContent.matchAll(/const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g);
                for (const match of arrowMatches) {
                    const [_, name, params = ''] = match;
                    functions.push({
                        name,
                        params: params.split(',').map((p: string) => p.trim()).filter(Boolean),
                        complexity: this.calculateComplexity(scriptContent)
                    });
                }
            });
        } catch (error) {
            console.error('Error analyzing HTML functions:', error);
        }

        return functions;
    }

    private calculateComplexity(scriptContent: string): number {
        let complexity = 1;
        
        const patterns = [
            /if\s*\(/g,
            /else\s+if\s*\(/g,
            /for\s*\(/g,
            /while\s*\(/g,
            /switch\s*\(/g,
            /\?\s*[^:]+\s*:/g
        ];
        
        patterns.forEach(pattern => {
            const matches = scriptContent.match(pattern);
            if (matches) {
                complexity += matches.length;
            }
        });
        
        return complexity;
    }

    analyzeStructure(content: string): { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] {
        const structures: { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] = [];
        
        try {
            const root = parseHTML(content);
            const lines = content.split('\n');
            
            // Analyze HTML structure
            const analyzeNode = (node: Node, depth: number = 0) => {
                if (!(node instanceof HTMLElement)) return;
                
                const tagName = node.tagName?.toLowerCase();
                if (!tagName) return;
                
                const startLine = content.slice(0, node.range?.[0] || 0).split('\n').length - 1;
                const endLine = content.slice(0, node.range?.[1] || 0).split('\n').length - 1;
                
                structures.push({
                    type: 'other',
                    name: tagName + (node.getAttribute('id') ? `#${node.getAttribute('id')}` : ''),
                    startLine,
                    endLine
                });
                
                node.childNodes.forEach((child: Node) => analyzeNode(child, depth + 1));
            };
            
            analyzeNode(root);
            
            // Find script sections
            root.querySelectorAll('script').forEach((script: HTMLElement) => {
                const scriptContent = script.text;
                const startLine = content.slice(0, script.range?.[0] || 0).split('\n').length - 1;
                
                structures.push({
                    type: 'function',
                    name: 'script',
                    startLine,
                    endLine: startLine + scriptContent.split('\n').length
                });
            });
            
            // Find style sections
            root.querySelectorAll('style').forEach((style: HTMLElement) => {
                const styleContent = style.text;
                const startLine = content.slice(0, style.range?.[0] || 0).split('\n').length - 1;
                
                structures.push({
                    type: 'other',
                    name: 'style',
                    startLine,
                    endLine: startLine + styleContent.split('\n').length
                });
            });
        } catch (error) {
            console.error('Error analyzing HTML structure:', error);
        }

        return structures;
    }

    detectSyntaxErrors(content: string): { line: number; column: number; message: string; }[] {
        const errors: { line: number; column: number; message: string; }[] = [];
        
        try {
            parseHTML(content, {
                lowerCaseTagName: false,
                comment: true,
                blockTextElements: {
                    script: true,
                    noscript: true,
                    style: true,
                    pre: true
                }
            });
        } catch (error: any) {
            const match = error.message.match(/Line (\d+): (.+)/);
            if (match) {
                errors.push({
                    line: parseInt(match[1]) - 1,
                    column: 0,
                    message: match[2]
                });
            }
        }

        // Additional validation
        const lines = content.split('\n');
        lines.forEach((line, index) => {
            // Check for unclosed tags
            const openTags = line.match(/<[^/][^>]*>/g) || [];
            const closeTags = line.match(/<\/[^>]+>/g) || [];
            if (openTags.length !== closeTags.length) {
                errors.push({
                    line: index,
                    column: 0,
                    message: 'Potentially unclosed HTML tag'
                });
            }
            
            // Check for invalid attributes
            const attrMatch = line.match(/\s+\w+(?!=)[^>]*/g);
            if (attrMatch) {
                attrMatch.forEach(attr => {
                    if (!/^[\w-]+=["'][^"']*["']$/.test(attr.trim())) {
                        errors.push({
                            line: index,
                            column: line.indexOf(attr),
                            message: 'Invalid attribute syntax'
                        });
                    }
                });
            }
        });

        return errors;
    }

    generateImports(dependencies: string[]): string {
        return dependencies.map(dep => {
            if (dep.endsWith('.css')) {
                return `<link rel="stylesheet" href="${dep}">`;
            } else if (dep.endsWith('.js')) {
                return `<script src="${dep}"></script>`;
            } else {
                return `<!-- Unknown dependency: ${dep} -->`;
            }
        }).join('\n');
    }

    generateFunction(name: string, params: string[], returnType: string, body: string): string {
        const paramsList = params.join(', ');
        return `<script>\nfunction ${name}(${paramsList}) {\n${this.indentCode(body)}\n}\n</script>`;
    }

    generateClass(name: string, properties: string[], methods: string[]): string {
        return `<div class="${name}">\n${this.indentCode(properties.join('\n'))}\n</div>`;
    }

    private indentCode(code: string, spaces: number = 4): string {
        return code.split('\n')
            .map(line => ' '.repeat(spaces) + line)
            .join('\n');
    }

    validateSyntax(content: string): boolean {
        try {
            parseHTML(content, {
                lowerCaseTagName: false,
                comment: true,
                blockTextElements: {
                    script: true,
                    noscript: true,
                    style: true,
                    pre: true
                }
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    validateImports(content: string): boolean {
        try {
            const root = parseHTML(content);
            
            // Check if CSS imports are in head
            const cssInHead = root.querySelectorAll('head link[rel="stylesheet"]').length;
            const totalCss = root.querySelectorAll('link[rel="stylesheet"]').length;
            
            // Check if JS imports are at the end of body
            const scripts = root.querySelectorAll('script[src]');
            const body = root.querySelector('body');
            const lastElement = body?.lastChild;
            const scriptAtEnd = lastElement instanceof HTMLElement && lastElement.tagName?.toLowerCase() === 'script';
            
            return cssInHead === totalCss && scriptAtEnd;
        } catch (error) {
            return false;
        }
    }

    validateStructure(content: string): boolean {
        try {
            const root = parseHTML(content);
            
            // Check for basic HTML structure
            const hasHtml = root.querySelector('html') !== null;
            const hasHead = root.querySelector('head') !== null;
            const hasBody = root.querySelector('body') !== null;
            const hasTitle = root.querySelector('title') !== null;
            
            return hasHtml && hasHead && hasBody && hasTitle;
        } catch (error) {
            return false;
        }
    }

    formatCode(content: string): string {
        try {
            const root = parseHTML(content);
            let formatted = '';
            let indent = 0;
            
            const formatNode = (node: Node) => {
                if (node.nodeType === 3) { // Text node
                    const text = node.text.trim();
                    if (text) {
                        formatted += ' '.repeat(indent) + text + '\n';
                    }
                } else if (node.nodeType === 1 && node instanceof HTMLElement) { // Element node
                    const tag = node.tagName.toLowerCase();
                    const attrString = Object.entries(node.rawAttributes || {})
                        .map(([key, value]) => `${key}="${value}"`)
                        .join(' ');
                    
                    formatted += ' '.repeat(indent) + `<${tag}${attrString ? ' ' + attrString : ''}>`;
                    
                    if (node.childNodes.length > 0) {
                        formatted += '\n';
                        indent += 2;
                        node.childNodes.forEach(child => formatNode(child));
                        indent -= 2;
                        formatted += ' '.repeat(indent);
                    }
                    
                    formatted += `</${tag}>\n`;
                }
            };
            
            formatNode(root);
            return formatted;
        } catch (error) {
            return content;
        }
    }

    injectImports(content: string, imports: string[]): string {
        try {
            const root = parseHTML(content);
            const head = root.querySelector('head');
            const body = root.querySelector('body');
            
            if (!head || !body) {
                return content;
            }
            
            const importStatements = this.generateImports(imports);
            const importNodes = parseHTML(importStatements);
            
            importNodes.childNodes.forEach(node => {
                const tagName = (node as any).tagName?.toLowerCase();
                if (tagName === 'link') {
                    head.appendChild(node);
                } else if (tagName === 'script') {
                    body.appendChild(node);
                }
            });
            
            return root.toString();
        } catch (error) {
            return content;
        }
    }

    wrapInFunction(content: string, functionName: string): string {
        return `<script>\nfunction ${functionName}() {\n${this.indentCode(content)}\n}\n</script>`;
    }
}
