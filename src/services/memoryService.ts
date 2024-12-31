import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileSystemService } from './fileSystemService';
import { ExecutionPlan, ErrorCorrection } from '../types';

interface ConversationMetadata {
    id: string;
    timestamp: string;
    models: string[];
    summary: string;
}

interface ConversationMemory {
    messages: Array<{
        role: 'user' | 'assistant';
        content: string;
        timestamp: string;
    }>;
    fileChanges: Array<{
        path: string;
        diff: string;
        timestamp: string;
    }>;
    codeAnalysis: Array<{
        path: string;
        analysis: string;
        errors?: string[];
        timestamp: string;
    }>;
    terminalLogs: Array<{
        command: string;
        output: string;
        timestamp: string;
    }>;
}

interface ExecutionPlanMemory {
    plans: Array<{
        id: string;
        plan: ExecutionPlan;
        timestamp: string;
        status: 'active' | 'completed' | 'failed';
    }>;
}

export class MemoryService {
    private readonly MAX_CONVERSATIONS = 250;
    private readonly CLEANUP_THRESHOLD = 50;
    private readonly memoryBasePath: string;
    private currentConversationId: string;
    private fileSystemService: FileSystemService;
    private outputChannel: vscode.OutputChannel;

    constructor(context: vscode.ExtensionContext) {
        this.memoryBasePath = path.join(context.globalStorageUri.fsPath, 'memory', 'conversations');
        this.currentConversationId = this.generateConversationId();
        this.fileSystemService = new FileSystemService();
        this.outputChannel = vscode.window.createOutputChannel('Memory Service');
        this.initializeMemorySystem();
    }

    private async initializeMemorySystem() {
        await fs.promises.mkdir(this.memoryBasePath, { recursive: true });
        await this.cleanupOldConversations();
    }

    private generateConversationId(): string {
        return `conversation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private async cleanupOldConversations() {
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

    async startNewConversation(initialContext?: string): Promise<string> {
        this.currentConversationId = this.generateConversationId();
        const conversationPath = path.join(this.memoryBasePath, this.currentConversationId);
        await fs.promises.mkdir(conversationPath);

        const metadata: ConversationMetadata = {
            id: this.currentConversationId,
            timestamp: new Date().toISOString(),
            models: [],
            summary: initialContext || ''
        };

        const memory: ConversationMemory = {
            messages: [],
            fileChanges: [],
            codeAnalysis: [],
            terminalLogs: []
        };

        await Promise.all([
            fs.promises.writeFile(
                path.join(conversationPath, 'metadata.json'),
                JSON.stringify(metadata, null, 2)
            ),
            fs.promises.writeFile(
                path.join(conversationPath, 'memory.json'),
                JSON.stringify(memory, null, 2)
            )
        ]);

        return this.currentConversationId;
    }

    async addMessage(role: 'user' | 'assistant', content: string) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        memory.messages.push({
            role,
            content,
            timestamp: new Date().toISOString()
        });

        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }

    async addFileChange(filePath: string, diff: string) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        memory.fileChanges.push({
            path: filePath,
            diff,
            timestamp: new Date().toISOString()
        });

        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }

    async addCodeAnalysis(filePath: string, analysis: string, errors?: string[]) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        memory.codeAnalysis.push({
            path: filePath,
            analysis,
            errors,
            timestamp: new Date().toISOString()
        });

        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }

    async addTerminalLog(command: string, output: string) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        memory.terminalLogs.push({
            command,
            output,
            timestamp: new Date().toISOString()
        });

        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }

    async getRecentContext(limit: number = 10): Promise<ConversationMemory> {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        return {
            messages: memory.messages.slice(-limit),
            fileChanges: memory.fileChanges.slice(-limit),
            codeAnalysis: memory.codeAnalysis.slice(-limit),
            terminalLogs: memory.terminalLogs.slice(-limit)
        };
    }

    async searchMemory(query: string): Promise<Array<{
        conversationId: string;
        relevance: number;
        context: Partial<ConversationMemory>;
    }>> {
        // Implementation for semantic search across conversations
        // This would be enhanced with actual embedding-based search
        const conversations = await fs.promises.readdir(this.memoryBasePath);
        const results = [];

        for (const convId of conversations) {
            const memoryPath = path.join(this.memoryBasePath, convId, 'memory.json');
            const memory: ConversationMemory = JSON.parse(
                await fs.promises.readFile(memoryPath, 'utf-8')
            );

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

    private calculateRelevance(query: string, memory: ConversationMemory): number {
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

    private countTermMatches(terms: string[], content: string): number {
        const normalizedContent = content.toLowerCase();
        return terms.reduce((score, term) => 
            score + (normalizedContent.includes(term) ? 1 : 0), 0);
    }

    private extractRelevantContext(query: string, memory: ConversationMemory): Partial<ConversationMemory> {
        const queryTerms = query.toLowerCase().split(' ');
        
        return {
            messages: memory.messages.filter(msg => 
                this.countTermMatches(queryTerms, msg.content) > 0
            ),
            codeAnalysis: memory.codeAnalysis.filter(analysis =>
                this.countTermMatches(queryTerms, analysis.analysis) > 0
            ),
            fileChanges: memory.fileChanges.filter(change =>
                this.countTermMatches(queryTerms, change.diff) > 0
            )
        };
    }

    async savePlanState(plan: ExecutionPlan) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory & ExecutionPlanMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        if (!memory.plans) {
            memory.plans = [];
        }

        // Map ExecutionPlan status to ExecutionPlanMemory status
        const memoryStatus = plan.status === 'completed' ? 'completed' :
                           plan.status === 'failed' ? 'failed' :
                           'active';  // 'planning', 'executing', 'retrying' all map to 'active'

        const existingPlanIndex = memory.plans.findIndex(p => p.id === plan.id);
        if (existingPlanIndex !== -1) {
            memory.plans[existingPlanIndex] = {
                id: plan.id,
                plan,
                timestamp: new Date().toISOString(),
                status: memoryStatus
            };
        } else {
            memory.plans.push({
                id: plan.id,
                plan,
                timestamp: new Date().toISOString(),
                status: memoryStatus
            });
        }

        await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
    }

    async getActivePlan(): Promise<ExecutionPlan | null> {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory & ExecutionPlanMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        if (!memory.plans) return null;

        const activePlan = memory.plans.find(p => p.status === 'active');
        return activePlan ? activePlan.plan : null;
    }

    private readonly CORRECTIONS_FILE = 'corrections.json';

    async addCorrection(correction: ErrorCorrection, success: boolean) {
        const correctionsPath = path.join(this.memoryBasePath, this.currentConversationId, this.CORRECTIONS_FILE);
        let corrections: ErrorCorrection[] = [];

        try {
            if (await fs.promises.access(correctionsPath).then(() => true).catch(() => false)) {
                corrections = JSON.parse(await fs.promises.readFile(correctionsPath, 'utf-8'));
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error reading corrections: ${error}`);
        }

        corrections.push({
            ...correction,
            suggestedFixes: correction.suggestedFixes.map(fix => ({
                ...fix,
                confidence: success ? Math.min(fix.confidence * 1.1, 1) : fix.confidence * 0.9
            }))
        });

        await fs.promises.writeFile(correctionsPath, JSON.stringify(corrections, null, 2));
    }

    async getCorrections(errorType?: string): Promise<ErrorCorrection[]> {
        const correctionsPath = path.join(this.memoryBasePath, this.currentConversationId, this.CORRECTIONS_FILE);
        let corrections: ErrorCorrection[] = [];

        try {
            if (await fs.promises.access(correctionsPath).then(() => true).catch(() => false)) {
                corrections = JSON.parse(await fs.promises.readFile(correctionsPath, 'utf-8'));
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error reading corrections: ${error}`);
        }

        return errorType ? corrections.filter(c => c.errorType === errorType) : corrections;
    }

    async addStepContext(planId: string, stepId: string, context: any) {
        const memoryPath = path.join(this.memoryBasePath, this.currentConversationId, 'memory.json');
        const memory: ConversationMemory & ExecutionPlanMemory = JSON.parse(
            await fs.promises.readFile(memoryPath, 'utf-8')
        );

        const plan = memory.plans?.find(p => p.id === planId);
        if (plan) {
            const step = plan.plan.steps.find(s => s.id === stepId);
            if (step) {
                step.context = context;
                await fs.promises.writeFile(memoryPath, JSON.stringify(memory, null, 2));
            }
        }
    }
}