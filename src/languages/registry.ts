import { LanguageHandler } from './base';
import { TypeScriptHandler } from './typescript';
import { PythonHandler } from './python';
import { JavaScriptHandler } from './javascript';
import { CSSHandler } from './css';
import { HTMLHandler } from './html';
import * as path from 'path';

export class LanguageRegistry {
    private static instance: LanguageRegistry;
    private handlers: Map<string, LanguageHandler> = new Map();

    private constructor() {
        this.registerDefaultHandlers();
    }

    public static getInstance(): LanguageRegistry {
        if (!LanguageRegistry.instance) {
            LanguageRegistry.instance = new LanguageRegistry();
        }
        return LanguageRegistry.instance;
    }

    private registerDefaultHandlers() {
        this.registerHandler(new TypeScriptHandler());
        this.registerHandler(new PythonHandler());
        this.registerHandler(new JavaScriptHandler());
        this.registerHandler(new CSSHandler());
        this.registerHandler(new HTMLHandler());
    }

    public registerHandler(handler: LanguageHandler) {
        handler.fileExtensions.forEach(ext => {
            this.handlers.set(ext, handler);
        });
    }

    public getHandlerForFile(filePath: string): LanguageHandler | undefined {
        const ext = path.extname(filePath);
        return this.handlers.get(ext);
    }

    public getHandlerForLanguageId(languageId: string): LanguageHandler | undefined {
        return Array.from(this.handlers.values()).find(h => h.languageId === languageId);
    }

    public getHandler(language: string): LanguageHandler | undefined {
        return this.handlers.get(language);
    }

    public getSupportedExtensions(): string[] {
        return Array.from(this.handlers.keys());
    }

    public getSupportedLanguageIds(): string[] {
        return Array.from(new Set(Array.from(this.handlers.values()).map(h => h.languageId)));
    }
}
