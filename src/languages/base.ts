import { CodeAnalysisResult, FileChange } from '../types';
import * as vscode from 'vscode';

export interface LanguageHandler {
    readonly fileExtensions: string[];
    readonly languageId: string;
    readonly importPatterns: RegExp[];
    readonly functionPatterns: RegExp[];
    readonly classPatterns: RegExp[];
    readonly blockPatterns: RegExp[];

    // Analysis methods
    analyzeImports(content: string): string[];
    analyzeDependencies(content: string): string[];
    analyzeFunctions(content: string): {
        name: string;
        params: string[];
        returnType?: string;
        complexity: number;
    }[];
    analyzeStructure(content: string): {
        type: 'class' | 'function' | 'interface' | 'variable' | 'other';
        name: string;
        startLine: number;
        endLine: number;
    }[];
    detectSyntaxErrors(content: string): {
        line: number;
        column: number;
        message: string;
    }[];

    // Generation methods
    generateImports(dependencies: string[]): string;
    generateFunction(name: string, params: string[], returnType: string, body: string): string;
    generateClass(name: string, properties: string[], methods: string[]): string;
    
    // Validation methods
    validateSyntax(content: string): boolean;
    validateImports(content: string): boolean;
    validateStructure(content: string): boolean;
    
    // Edit helpers
    formatCode(content: string): string;
    injectImports(content: string, imports: string[]): string;
    wrapInFunction(content: string, functionName: string): string;

    // Additional methods
    getImports(document: vscode.TextDocument): Promise<string[]>;
    getDependencies(document: vscode.TextDocument): Promise<string[]>;
    getFileStructure(document: vscode.TextDocument): Promise<Array<{
        type: string;
        name: string;
        range: {
            start: { line: number };
            end: { line: number };
        };
    }>>;
    analyze(document: vscode.TextDocument): Promise<any>;
    format(document: vscode.TextDocument): Promise<string>;
}

export abstract class BaseLanguageHandler implements LanguageHandler {
    abstract readonly fileExtensions: string[];
    abstract readonly languageId: string;
    abstract readonly importPatterns: RegExp[];
    abstract readonly dependencyPatterns: RegExp[];
    abstract readonly functionPatterns: RegExp[];
    abstract readonly classPatterns: RegExp[];
    abstract readonly blockPatterns: RegExp[];

    protected findMatches(content: string, pattern: RegExp): RegExpMatchArray[] {
        return Array.from(content.matchAll(pattern));
    }

    protected getLineNumber(content: string, index: number): number {
        return content.substring(0, index).split('\n').length;
    }

    protected abstract parseImport(match: RegExpMatchArray): string;
    protected abstract parseFunction(match: RegExpMatchArray): {
        name: string;
        params: string[];
        returnType?: string;
    };

    analyzeImports(content: string): string[] {
        return this.importPatterns
            .flatMap(pattern => this.findMatches(content, pattern))
            .map(match => this.parseImport(match));
    }

    abstract analyzeDependencies(content: string): string[];
    abstract analyzeFunctions(content: string): {
        name: string;
        params: string[];
        returnType?: string;
        complexity: number;
    }[];
    abstract analyzeStructure(content: string): {
        type: 'class' | 'function' | 'interface' | 'variable' | 'other';
        name: string;
        startLine: number;
        endLine: number;
    }[];
    abstract detectSyntaxErrors(content: string): {
        line: number;
        column: number;
        message: string;
    }[];

    abstract generateImports(dependencies: string[]): string;
    abstract generateFunction(name: string, params: string[], returnType: string, body: string): string;
    abstract generateClass(name: string, properties: string[], methods: string[]): string;
    
    abstract validateSyntax(content: string): boolean;
    abstract validateImports(content: string): boolean;
    abstract validateStructure(content: string): boolean;
    
    abstract formatCode(content: string): string;
    abstract injectImports(content: string, imports: string[]): string;
    abstract wrapInFunction(content: string, functionName: string): string;

    async getImports(document: vscode.TextDocument): Promise<string[]> {
        const content = document.getText();
        const imports: string[] = [];
        
        for (const pattern of this.importPatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                if (match[1]) {
                    imports.push(match[1]);
                }
            }
        }
        
        return imports;
    }

    async getDependencies(document: vscode.TextDocument): Promise<string[]> {
        const content = document.getText();
        const dependencies: string[] = [];
        
        for (const pattern of this.dependencyPatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                if (match[1]) {
                    dependencies.push(match[1]);
                }
            }
        }
        
        return dependencies;
    }

    async getFileStructure(document: vscode.TextDocument): Promise<Array<{
        type: string;
        name: string;
        range: {
            start: { line: number };
            end: { line: number };
        };
    }>> {
        // Default implementation - should be overridden by specific language handlers
        return [];
    }

    async analyze(document: vscode.TextDocument): Promise<any> {
        const content = document.getText();
        return {
            imports: await this.getImports(document),
            dependencies: await this.getDependencies(document),
            structure: await this.getFileStructure(document),
            syntaxValid: this.validateSyntax(content),
            importsValid: this.validateImports(content),
            structureValid: this.validateStructure(content)
        };
    }

    async format(document: vscode.TextDocument): Promise<string> {
        return this.formatCode(document.getText());
    }
}
