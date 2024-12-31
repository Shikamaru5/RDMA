import * as vscode from 'vscode';
import { ThresholdData } from '../types';

export class ThresholdManager {
    private thresholds: Map<string, ThresholdData> = new Map();
    private readonly DEFAULT_THRESHOLD = 0.7;
    private readonly MIN_THRESHOLD = 0.3;
    private readonly MAX_THRESHOLD = 0.9;
    private readonly LEARNING_RATE = 0.1;
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Threshold Manager');
    }

    async adjustThreshold(type: string, context: string, success: boolean) {
        try {
            const data = this.thresholds.get(type) || this.initializeThreshold(type);
            
            // Update success history
            data.history.push({ 
                context, 
                success, 
                timestamp: Date.now() 
            });
            
            // Maintain history size
            if (data.history.length > 1000) {
                data.history = data.history.slice(-1000);
            }
            
            // Update contextual threshold
            const contextualData = data.contextual.get(context) || {
                threshold: data.baseThreshold,
                successRate: 0,
                sampleSize: 0
            };
            
            // Update metrics
            contextualData.sampleSize++;
            contextualData.successRate = this.calculateNewSuccessRate(
                contextualData.successRate,
                success,
                contextualData.sampleSize
            );
            
            // Adjust threshold based on performance
            contextualData.threshold = this.calculateNewThreshold(
                contextualData.threshold,
                contextualData.successRate,
                contextualData.sampleSize
            );
            
            // Ensure threshold stays within bounds
            contextualData.threshold = Math.max(
                this.MIN_THRESHOLD,
                Math.min(this.MAX_THRESHOLD, contextualData.threshold)
            );
            
            data.contextual.set(context, contextualData);
            this.thresholds.set(type, data);
            
            // Periodically update base threshold based on all contexts
            if (this.shouldUpdateBaseThreshold(data)) {
                data.baseThreshold = this.calculateNewBaseThreshold(data);
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error adjusting threshold: ${error}`);
        }
    }

    getThreshold(type: string, context: string): number {
        try {
            const data = this.thresholds.get(type);
            if (!data) return this.DEFAULT_THRESHOLD;
            
            const contextual = data.contextual.get(context);
            return contextual ? contextual.threshold : data.baseThreshold;
        } catch (error) {
            this.outputChannel.appendLine(`Error getting threshold: ${error}`);
            return this.DEFAULT_THRESHOLD;
        }
    }

    private initializeThreshold(type: string): ThresholdData {
        return {
            baseThreshold: this.DEFAULT_THRESHOLD,
            contextual: new Map(),
            history: []
        };
    }

    private calculateNewSuccessRate(
        currentRate: number,
        success: boolean,
        sampleSize: number
    ): number {
        return ((currentRate * (sampleSize - 1)) + (success ? 1 : 0)) / sampleSize;
    }

    private calculateNewThreshold(
        currentThreshold: number,
        successRate: number,
        sampleSize: number
    ): number {
        // More aggressive adjustment for small sample sizes
        const adaptiveLearningRate = this.LEARNING_RATE * (1 + 5 / Math.max(sampleSize, 5));
        
        // If success rate is high, increase threshold
        if (successRate > 0.8) {
            return currentThreshold + (adaptiveLearningRate * (1 - currentThreshold));
        }
        // If success rate is low, decrease threshold
        else if (successRate < 0.6) {
            return currentThreshold - (adaptiveLearningRate * currentThreshold);
        }
        
        return currentThreshold;
    }

    private shouldUpdateBaseThreshold(data: ThresholdData): boolean {
        // Update base threshold every 100 samples across all contexts
        const totalSamples = Array.from(data.contextual.values())
            .reduce((sum, ctx) => sum + ctx.sampleSize, 0);
        return totalSamples % 100 === 0;
    }

    private calculateNewBaseThreshold(data: ThresholdData): number {
        const contexts = Array.from(data.contextual.values());
        if (contexts.length === 0) return this.DEFAULT_THRESHOLD;

        // Weight each context's threshold by its sample size
        const totalSamples = contexts.reduce((sum, ctx) => sum + ctx.sampleSize, 0);
        const weightedSum = contexts.reduce(
            (sum, ctx) => sum + (ctx.threshold * ctx.sampleSize),
            0
        );

        return weightedSum / totalSamples;
    }
}
