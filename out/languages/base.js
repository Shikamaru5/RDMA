"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseLanguageHandler = void 0;
class BaseLanguageHandler {
    findMatches(content, pattern) {
        return Array.from(content.matchAll(pattern));
    }
    getLineNumber(content, index) {
        return content.substring(0, index).split('\n').length;
    }
    analyzeImports(content) {
        return this.importPatterns
            .flatMap(pattern => this.findMatches(content, pattern))
            .map(match => this.parseImport(match));
    }
}
exports.BaseLanguageHandler = BaseLanguageHandler;
//# sourceMappingURL=base.js.map