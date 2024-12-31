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
exports.LanguageRegistry = void 0;
const typescript_1 = require("./typescript");
const python_1 = require("./python");
const javascript_1 = require("./javascript");
const css_1 = require("./css");
const html_1 = require("./html");
const path = __importStar(require("path"));
class LanguageRegistry {
    constructor() {
        this.handlers = new Map();
        this.registerDefaultHandlers();
    }
    static getInstance() {
        if (!LanguageRegistry.instance) {
            LanguageRegistry.instance = new LanguageRegistry();
        }
        return LanguageRegistry.instance;
    }
    registerDefaultHandlers() {
        this.registerHandler(new typescript_1.TypeScriptHandler());
        this.registerHandler(new python_1.PythonHandler());
        this.registerHandler(new javascript_1.JavaScriptHandler());
        this.registerHandler(new css_1.CSSHandler());
        this.registerHandler(new html_1.HTMLHandler());
    }
    registerHandler(handler) {
        handler.fileExtensions.forEach(ext => {
            this.handlers.set(ext, handler);
        });
    }
    getHandlerForFile(filePath) {
        const ext = path.extname(filePath);
        return this.handlers.get(ext);
    }
    getHandlerForLanguageId(languageId) {
        return Array.from(this.handlers.values()).find(h => h.languageId === languageId);
    }
    getSupportedExtensions() {
        return Array.from(this.handlers.keys());
    }
    getSupportedLanguageIds() {
        return Array.from(new Set(Array.from(this.handlers.values()).map(h => h.languageId)));
    }
}
exports.LanguageRegistry = LanguageRegistry;
//# sourceMappingURL=registry.js.map