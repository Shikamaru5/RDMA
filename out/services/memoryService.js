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
exports.MemoryService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fileSystemService_1 = require("./fileSystemService");
class MemoryService {
    constructor(context) {
        this.MAX_CONVERSATIONS = 250;
        this.CLEANUP_THRESHOLD = 50;
        this.memoryBasePath = path.join(context.globalStorageUri.fsPath, 'memory', 'conversations');
        this.currentConversationId = this.generateConversationId();
        this.fileSystemService = new fileSystemService_1.FileSystemService();
        this.initializeMemorySystem();
    }
    async initializeMemorySystem() {
        await fs.promises.mkdir(this.memoryBasePath, { recursive: true });
        await this.cleanupOldConversations();
    }
    generateConversationId() {
        return `conversation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    async cleanupOldConversations() {
        const conversations = await fs.promises.readdir(this.memoryBasePath);
        if (conversations.length > this.MAX_CONVERSATIONS) {
            const toDelete = conversations
                .sort((a, b) => {
                const aTime = parseInt(a.split('_')[1]);
                const bTime = parseInt(b.split('_')[1]);
                return aTime - bTime;
            })
                .slice(0, this.CLEANUP_THRESHOLD);
            for (const conv of toDelete) {
                await fs.promises.rm(path.join(this.memoryBasePath, conv), { recursive: true });
            }
        }
    }
    async startNewConversation(initialContext) {
        this.currentConversationId = this.generateConversationId();
        const conversationPath = path.join(this.memoryBasePath, this.currentConversationId);
        await fs.promises.mkdir(conversationPath);
        const metadata = {
            id: this.currentConversationId,
            timestamp: new Date().toISOString(),
            models: [],
            summary: initialContext || ''
        };
        const memory = {
            messages: [],
            fileChanges: [],
            codeAnalysis: [],
            terminalLogs: []
        };
        await Promise.all([
            fs.promises.writeFile(path.join(conversationPath, 'metadata.json'), JSON.stringify(metadata, null, 2)),
            fs.promises.writeFile(path.join(conversationPath, 'memory.json'), JSON.stringify(memory, null, 2))
        ]);
        return this.currentConversationId;
    }
    async addMessage(role, content) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory = JSON.parse(await fs.promises.readFile(memoryPath, 'utf-8'));
        memory.messages.push({
            role,
            content,
            timestamp: new Date().toISOString()
        });
        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }
    async addFileChange(filePath, diff) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory = JSON.parse(await fs.promises.readFile(memoryPath, 'utf-8'));
        memory.fileChanges.push({
            path: filePath,
            diff,
            timestamp: new Date().toISOString()
        });
        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }
    async addCodeAnalysis(filePath, analysis, errors) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory = JSON.parse(await fs.promises.readFile(memoryPath, 'utf-8'));
        memory.codeAnalysis.push({
            path: filePath,
            analysis,
            errors,
            timestamp: new Date().toISOString()
        });
        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }
    async addTerminalLog(command, output) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory = JSON.parse(await fs.promises.readFile(memoryPath, 'utf-8'));
        memory.terminalLogs.push({
            command,
            output,
            timestamp: new Date().toISOString()
        });
        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }
    async getRecentContext(limit = 10) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory = JSON.parse(await fs.promises.readFile(memoryPath, 'utf-8'));
        return {
            messages: memory.messages.slice(-limit),
            fileChanges: memory.fileChanges.slice(-limit),
            codeAnalysis: memory.codeAnalysis.slice(-limit),
            terminalLogs: memory.terminalLogs.slice(-limit)
        };
    }
    async searchMemory(query) {
        // Implementation for semantic search across conversations
        // This would be enhanced with actual embedding-based search
        const conversations = await fs.promises.readdir(this.memoryBasePath);
        const results = [];
        for (const convId of conversations) {
            const memoryPath = path.join(this.memoryBasePath, convId, 'memory.json');
            const memory = JSON.parse(await fs.promises.readFile(memoryPath, 'utf-8'));
            // Simple text-based relevance scoring
            const relevance = this.calculateRelevance(query, memory);
            if (relevance > 0) {
                results.push({
                    conversationId: convId,
                    relevance,
                    context: this.extractRelevantContext(query, memory)
                });
            }
        }
        return results.sort((a, b) => b.relevance - a.relevance);
    }
    calculateRelevance(query, memory) {
        let score = 0;
        const queryTerms = query.toLowerCase().split(' ');
        // Check messages
        for (const msg of memory.messages) {
            score += this.countTermMatches(queryTerms, msg.content);
        }
        // Check code analysis
        for (const analysis of memory.codeAnalysis) {
            score += this.countTermMatches(queryTerms, analysis.analysis);
        }
        return score;
    }
    countTermMatches(terms, content) {
        const normalizedContent = content.toLowerCase();
        return terms.reduce((score, term) => score + (normalizedContent.includes(term) ? 1 : 0), 0);
    }
    extractRelevantContext(query, memory) {
        const queryTerms = query.toLowerCase().split(' ');
        return {
            messages: memory.messages.filter(msg => this.countTermMatches(queryTerms, msg.content) > 0),
            codeAnalysis: memory.codeAnalysis.filter(analysis => this.countTermMatches(queryTerms, analysis.analysis) > 0),
            fileChanges: memory.fileChanges.filter(change => this.countTermMatches(queryTerms, change.diff) > 0)
        };
    }
}
exports.MemoryService = MemoryService;
//# sourceMappingURL=memoryService.js.map