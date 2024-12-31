import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileSystemService } from './fileSystemService';
import { ModelCoordinator } from './modelCoordinator';
import ollama from 'ollama';
import nodeFetch, { Response, Headers, Request } from 'node-fetch';
import { Readable } from 'stream';
import { OllamaModel, TaskType, TaskResult, ValidationResult, FileChange, Task } from '../types';

// Use node-fetch explicitly
const fetch = nodeFetch;

export interface ModelState {
    isRunning: boolean;
    lastUsed: Date;
    performance: {
        avgResponseTime: number;
        errorRate: number;
        successfulTasks: number;
        failedTasks: number;
    };
}

interface TaskQueue {
    id: string;
    type: TaskType;
    prompt: string;
    requiresModelSwitch: boolean;
    callback: (result: any) => void;
}

export class OllamaService {
    private WSL_HOST = '172.27.208.1';  // Keep this for other potential WSL interactions
    private ollamaHost: string | undefined;
    private outputChannel: vscode.OutputChannel;
    private context: vscode.ExtensionContext;
    private conversationHistory: Map<string, any[]>;
    private currentModel: string;
    private readonly CHAT_MODEL = 'hermes3:8b';
    private readonly CODE_MODEL = 'qwen2.5-coder:7b';
    private readonly VISION_MODEL = 'llama3.2-vision:11b';
    private fileSystemService: FileSystemService;
    private isModelRunning: boolean = false;
    private initializationPromise: Promise<void>;
    private modelStates: Map<string, ModelState> = new Map();
    private taskQueue: TaskQueue[] = [];
    private currentTask: TaskQueue | null = null;
    private modelCoordinator: ModelCoordinator;
    private templates: Map<string, any> = new Map();
    private isGPUAvailable: boolean = false;
    private modelParameters = {
        num_gpu: 1,
        num_thread: 8,
        batch_size: 512,
        context_length: 4096,
    };

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('Ollama Service');
        this.outputChannel.show();
        this.conversationHistory = new Map();
        this.fileSystemService = new FileSystemService();
        this.currentModel = this.CHAT_MODEL;
        this.modelCoordinator = new ModelCoordinator(this, context);
        this.initializationPromise = this.initializeService();
        this.loadTemplates();
    }

    public setModelCoordinator(coordinator: ModelCoordinator) {
        this.modelCoordinator = coordinator;
    }

    private async startOllamaProcess(): Promise<void> {
        try {
            // Path to Ollama executable in Windows
            const ollamaPath = 'C:\\Users\\Kalvin\\AppData\\Local\\Programs\\Ollama\\ollama.exe';
            
            // First cleanup any zombie processes
            await this.cleanupZombieProcesses();
            
            // Check if Ollama is already running after cleanup
            const isRunning = await this.findRunningOllamaProcess();
            if (isRunning) {
                // If it's running after cleanup, it's a valid process
                this.outputChannel.appendLine('Ollama process is already running and responsive');
                return;
            }

            // Start Ollama using PowerShell with explicit configuration
            this.outputChannel.appendLine('Starting Ollama process...');
            const startProcess = require('child_process').spawn(
                '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                [
                    '-Command',
                    `$env:OLLAMA_HOST='0.0.0.0:11434'; $env:OLLAMA_ORIGINS='*'; & "${ollamaPath}" serve`
                ],
                { 
                    windowsHide: true,
                    stdio: 'pipe',
                    env: {
                        ...process.env,
                        OLLAMA_HOST: '0.0.0.0:11434',
                        OLLAMA_ORIGINS: '*',
                        OLLAMA_CORS: '*'
                    }
                }
            );

            // Log any stderr output
            startProcess.stderr?.on('data', (data: Buffer | string) => {
                const message = data.toString();
                this.outputChannel.appendLine(`Ollama stderr: ${message}`);
                
                // If we get "address in use" after our cleanup, something is wrong
                // Kill the process and throw an error
                if (message.includes('address already in use')) {
                    this.outputChannel.appendLine('Port 11434 is still in use after cleanup. Something is wrong.');
                    startProcess.kill();
                    throw new Error('Port 11434 is still in use after cleanup');
                }
            });

            startProcess.stdout?.on('data', (data: Buffer | string) => {
                this.outputChannel.appendLine(`Ollama stdout: ${data.toString()}`);
            });

            // Handle process exit
            startProcess.on('exit', (code: number | null) => {
                if (code !== 0) {
                    this.outputChannel.appendLine(`Ollama process exited with code ${code}`);
                }
            });

            // Wait for Ollama to start and verify it's responding
            await new Promise(resolve => setTimeout(resolve, 8000));
            
            // Verify the process is actually responding
            const isResponding = await this.findRunningOllamaProcess();
            if (!isResponding) {
                throw new Error('Ollama process started but is not responding');
            }
            
            this.outputChannel.appendLine('Ollama process started and verified');
        } catch (error) {
            this.outputChannel.appendLine(`Error starting Ollama process: ${error}`);
            throw error;
        }
    }

    private async getWindowsHostname(): Promise<string> {
        try {
            const result = require('child_process').spawnSync(
                '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                ['-Command', '(Get-WmiObject Win32_ComputerSystem).DNSHostName'],
                { encoding: 'utf8' }
            );
            const hostname = result.stdout.trim();
            return hostname || 'localhost';
        } catch (error) {
            this.outputChannel.appendLine(`Error getting Windows hostname: ${error}`);
            return 'localhost';
        }
    }

    private async testConnection(host: string): Promise<boolean> {
        try {
            const url = `http://${host}:11434/api/version`;
            this.outputChannel.appendLine(`Testing connection to ${url}`);
            
            // Add timeout to fetch to avoid hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
            
            try {
                const response = await fetch(url, {
                    signal: controller.signal,
                    headers: {
                        'Accept': 'application/json'
                    }
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    this.outputChannel.appendLine(`HTTP connection test failed for ${host}: ${response.status}`);
                    return false;
                }
                
                // Try to parse the response to ensure it's valid
                const data = await response.json();
                if (!data.version) {
                    this.outputChannel.appendLine(`Invalid response from ${host}`);
                    return false;
                }
                
                this.outputChannel.appendLine(`HTTP connection successful to ${url}`);
                return true;
            } catch (error) {
                clearTimeout(timeoutId);
                this.outputChannel.appendLine(`HTTP connection test failed for ${host}: ${error}`);
                return false;
            }
        } catch (error) {
            this.outputChannel.appendLine(`Connection test failed completely for ${host}: ${error}`);
            return false;
        }
    }

    private async initializeService() {
        try {
            this.outputChannel.appendLine('Initializing Ollama service...');
            
            // Clean up any existing processes
            await this.cleanupZombieProcesses();
            
            // Start the Ollama server
            await this.startOllamaProcess();
    
            // Set the host for the ollama npm package - use WSL_HOST when in WSL
            const host = process.platform === 'linux' ? this.WSL_HOST : 'localhost';
            process.env.OLLAMA_HOST = `http://${host}:11434`;
            this.ollamaHost = process.env.OLLAMA_HOST;
            
            this.outputChannel.appendLine(`Using Ollama host: ${this.ollamaHost}`);
            
            // Verify connection
            try {
                const response = await fetch(`${this.ollamaHost}/api/tags`);
                const data = await response.json();
                this.outputChannel.appendLine(`Connected to Ollama. Available models: ${JSON.stringify(data.models)}`);
            } catch (error) {
                throw new Error(`Failed to connect to Ollama at ${this.ollamaHost}: ${error}`);
            }
            
            this.isModelRunning = true;
            this.outputChannel.appendLine('Ollama server started successfully');
        } catch (error) {
            this.logError('Failed to initialize Ollama service:', error);
            throw error;
        }
    }

    private async loadTemplates() {
        try {
            const hermes3Template = require('../templates/hermes3Template');
            const qwenTemplate = require('../templates/qwenTemplate');
            
            this.templates.set('hermes3Template', {
                systemPrompt: hermes3Template.HERMES3_SYSTEM_TEMPLATE,
                generateTaskPrompt: hermes3Template.generateTaskPrompt,
                validateResponse: hermes3Template.validateResponse
            });
            
            this.templates.set('qwenTemplate', {
                systemPrompt: qwenTemplate.QWEN_SYSTEM_TEMPLATE,
                generateTaskPrompt: qwenTemplate.generateTaskPrompt,
                validateResponse: qwenTemplate.validateResponse
            });
        } catch (error) {
            this.outputChannel.appendLine(`Error loading templates: ${error}`);
            throw error;
        }
    }

    private initializeModelState(model: string): ModelState {
        return {
            isRunning: false,
            lastUsed: new Date(),
            performance: {
                avgResponseTime: 0,
                errorRate: 0,
                successfulTasks: 0,
                failedTasks: 0
            }
        };
    }

    private updateModelPerformance(model: string, success: boolean, responseTime: number) {
        const state = this.modelStates.get(model) || this.initializeModelState(model);
        const perf = state.performance;
        
        if (success) {
            perf.successfulTasks++;
        } else {
            perf.failedTasks++;
        }
        
        perf.errorRate = perf.failedTasks / (perf.successfulTasks + perf.failedTasks);
        
        // Update average response time using rolling average
        const totalTasks = perf.successfulTasks + perf.failedTasks;
        perf.avgResponseTime = (perf.avgResponseTime * (totalTasks - 1) + responseTime) / totalTasks;
        
        state.lastUsed = new Date();
        this.modelStates.set(model, state);
    }

    public async waitForInitialization() {
        return this.initializationPromise;
    }

    private async cleanupZombieProcesses(): Promise<void> {
        try {
            const findProcess = require('child_process').spawnSync(
                '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                ['-Command', 'Get-Process -Name ollama -ErrorAction SilentlyContinue | Stop-Process -Force'],
                { windowsHide: true }
            );
            
            if (findProcess.stderr) {
                const error = findProcess.stderr.toString().trim();
                if (error && !error.includes('Cannot find a process')) {
                    this.outputChannel.appendLine(`Warning during process cleanup: ${error}`);
                }
            }
            
            // Wait a bit for cleanup
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            this.outputChannel.appendLine(`Warning: Error during process cleanup: ${error}`);
        }
    }

    private async validateConnection(): Promise<void> {
        try {
            // Test connection using ollama package
            const models = await ollama.list();
            this.outputChannel.appendLine(`Connected to Ollama. Available models: ${JSON.stringify(models)}`);
            this.isModelRunning = true;
        } catch (error) {
            this.outputChannel.appendLine(`Failed to connect to Ollama at ${process.env.OLLAMA_HOST}`);
            throw error;
        }
    }

    private async detectWindowsHostIp(): Promise<string> {
        try {
            // Get the Windows host IP from /etc/resolv.conf which contains the Windows host address
            const resolvResult = require('child_process').spawnSync('cat', ['/etc/resolv.conf'], {
                encoding: 'utf8'
            });
            
            if (resolvResult.stdout) {
                const nameserverMatch = resolvResult.stdout.match(/nameserver\s+([\d.]+)/);
                if (nameserverMatch && nameserverMatch[1]) {
                    const windowsHostIp = nameserverMatch[1];
                    this.outputChannel.appendLine(`Found Windows host IP via resolv.conf: ${windowsHostIp}`);
                    
                    // Test connection to Ollama on Windows
                    try {
                        const response = await fetch(`http://${windowsHostIp}:11434/api/version`);
                        if (response.ok) {
                            this.outputChannel.appendLine(`Successfully connected to Ollama on Windows host at ${windowsHostIp}`);
                            return windowsHostIp;
                        }
                    } catch (e) {
                        this.outputChannel.appendLine(`Failed to connect to Ollama on ${windowsHostIp}: ${e}`);
                    }
                }
            }
    
            // Fallback: Try to get the host.docker.internal which often points to Windows host
            try {
                const hostResult = require('child_process').spawnSync('cat', ['/etc/hosts'], {
                    encoding: 'utf8'
                });
                
                if (hostResult.stdout) {
                    const dockerHostMatch = hostResult.stdout.match(/host\.docker\.internal\s+([\d.]+)/);
                    if (dockerHostMatch && dockerHostMatch[1]) {
                        const dockerHostIp = dockerHostMatch[1];
                        this.outputChannel.appendLine(`Found Windows host IP via host.docker.internal: ${dockerHostIp}`);
                        
                        // Test connection
                        try {
                            const response = await fetch(`http://${dockerHostIp}:11434/api/version`);
                            if (response.ok) {
                                this.outputChannel.appendLine(`Successfully connected to Ollama on Docker host at ${dockerHostIp}`);
                                return dockerHostIp;
                            }
                        } catch (e) {
                            this.outputChannel.appendLine(`Failed to connect to Ollama on ${dockerHostIp}: ${e}`);
                        }
                    }
                }
            } catch (error) {
                this.outputChannel.appendLine(`Error checking host.docker.internal: ${error}`);
            }
    
            // Last resort: Try the default WSL host
            this.outputChannel.appendLine(`Falling back to default WSL host: ${this.WSL_HOST}`);
            return this.WSL_HOST;
        } catch (error) {
            this.outputChannel.appendLine(`Error detecting Windows host IP: ${error}`);
            return this.WSL_HOST;
        }
    }

    private async findRunningOllamaProcess(): Promise<boolean> {
        try {
            // First check if the process exists
            const findProcess = require('child_process').spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
                '-Command',
                'Get-Process -Name ollama -ErrorAction SilentlyContinue'
            ], { 
                encoding: 'utf8',
                windowsHide: true
            });

            if (!findProcess.stdout?.includes('ollama')) {
                this.outputChannel.appendLine('No Ollama process found');
                return false;
            }

            // Process exists, now check if it's responsive
            try {
                const response = await fetch(`http://${this.WSL_HOST}:11434/api/version`, {
                    timeout: 2000 // 2 second timeout
                });
                
                if (!response.ok) {
                    this.outputChannel.appendLine('Ollama process exists but API is not responding');
                    return false;
                }

                // Try to list models as final check
                await ollama.list();
                this.outputChannel.appendLine('Ollama process is running and responsive');
                return true;
            } catch (error) {
                this.outputChannel.appendLine(`Ollama process exists but not healthy: ${error}`);
                
                // Kill the non-responsive process
                const pid = findProcess.stdout.match(/(\d+)\s+ollama/)?.[1];
                if (pid) {
                    this.outputChannel.appendLine(`Killing non-responsive Ollama process (PID: ${pid})...`);
                    require('child_process').spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
                        '-Command',
                        `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`
                    ]);
                }
                return false;
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error checking Ollama process: ${error}`);
            return false;
        }
    }

    private async checkOllamaStatus(): Promise<boolean> {
        try {
            const models = await ollama.list();
            this.outputChannel.appendLine(`Ollama is running with models: ${JSON.stringify(models)}`);
            this.isModelRunning = true;
            return true;
        } catch (error: any) {
            this.isModelRunning = false;
            if (error?.code === 'ECONNREFUSED') {
                this.outputChannel.appendLine('Connection refused, Ollama server is not running');
            } else if (error?.code === 'ETIMEDOUT') {
                this.outputChannel.appendLine('Connection timed out, Ollama server might be starting up');
            } else {
                this.outputChannel.appendLine(`Error checking Ollama status: ${error?.message}`);
            }
            throw error;
        }
    }

    private async handleStreamingResponse(response: Response): Promise<void> {
        const stream = Readable.from(response.body);
        
        return new Promise((resolve, reject) => {
            let buffer = '';
            
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const data = JSON.parse(line);
                            if (data.status) {
                                this.outputChannel.appendLine(`Pull progress: ${data.status}`);
                            }
                        } catch (e) {
                            this.outputChannel.appendLine(`Raw progress: ${line}`);
                        }
                    }
                }
            });
            
            stream.on('end', () => {
                if (buffer.trim()) {
                    try {
                        const data = JSON.parse(buffer);
                        if (data.status) {
                            this.outputChannel.appendLine(`Pull progress: ${data.status}`);
                        }
                    } catch (e) {
                        this.outputChannel.appendLine(`Raw progress: ${buffer}`);
                    }
                }
                resolve();
            });
            
            stream.on('error', (error) => {
                reject(error);
            });
        });
    }

    public async ensureModelLoaded(modelName: string): Promise<void> {
        try {
            // Ensure the server is running
            if (!this.isModelRunning) {
                await this.initializeService();
            }

            this.outputChannel.appendLine(`Checking for model ${modelName}`);
    
            // Get list of available models using direct API call
            const response = await fetch(`${this.ollamaHost}/api/tags`);
            const data = await response.json();
            this.outputChannel.appendLine(`Available models: ${JSON.stringify(data.models)}`);
            
            const modelExists = data.models?.some((model: any) => 
                // Check both name and name:tag format
                model.name === modelName || `${model.name}:${model.tag}` === modelName
            );
            
            if (!modelExists) {
                throw new Error(`Model ${modelName} not found in available models`);
            }
            
            // Verify model can be loaded by attempting a simple completion
            try {
                const testResponse = await fetch(`${this.ollamaHost}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelName,
                        prompt: 'test',
                        stream: false
                    })
                });
                
                if (!testResponse.ok) {
                    throw new Error(`Failed to load model ${modelName}: ${testResponse.statusText}`);
                }
                
                // Set as current model after successful verification
                this.currentModel = modelName;
                this.isModelRunning = true;
                
                // Initialize model state if needed
                if (!this.modelStates.has(modelName)) {
                    this.modelStates.set(modelName, this.initializeModelState(modelName));
                }
                
                this.outputChannel.appendLine(`Model ${modelName} successfully loaded and set as current model`);
            } catch (error) {
                throw new Error(`Failed to load model ${modelName}: ${error}`);
            }
        } catch (error) {
            this.logError(`Failed to ensure model ${modelName} is loaded:`, error);
            throw error;
        }
    }

    private async unloadCurrentModel(): Promise<void> {
        if (this.currentModel && this.isModelRunning) {
            try {
                this.outputChannel.appendLine(`Unloading current model ${this.currentModel}...`);
                
                // Unload the model using keep_alive: 0
                await ollama.chat({
                    model: this.currentModel,
                    messages: [{ role: 'user', content: '' }],
                    keep_alive: 0
                });
                
                this.isModelRunning = false;
                this.modelStates.delete(this.currentModel);
                this.outputChannel.appendLine(`Successfully unloaded model ${this.currentModel}`);
            } catch (error) {
                this.outputChannel.appendLine(`Warning: Error unloading model ${this.currentModel}: ${error instanceof Error ? error.message : String(error)}`);
                // Even if unload fails, we'll proceed with switching
            }
        }
    }

    async switchModel(modelName: string): Promise<boolean> {
        try {
            this.outputChannel.appendLine(`Switching to model ${modelName}...`);
            
            // First check if model exists
            const models = await this.listModels();
            if (!models.includes(modelName)) {
                throw new Error(`Model ${modelName} not found`);
            }

            // Unload current model before switching
            await this.unloadCurrentModel();
            
            // Load the new model
            await this.ensureModelLoaded(modelName);
            
            // Update state
            this.currentModel = modelName;
            this.isModelRunning = true;
            this.modelStates.set(modelName, {
                isRunning: true,
                lastUsed: new Date(),
                performance: {
                    avgResponseTime: 0,
                    errorRate: 0,
                    successfulTasks: 0,
                    failedTasks: 0
                }
            });
            
            // Initialize conversation history if needed
            if (!this.conversationHistory.has(modelName)) {
                this.conversationHistory.set(modelName, []);
            }
            
            this.outputChannel.appendLine(`Successfully switched to model ${modelName}`);
            return true;
        } catch (error: any) {
            const errorMsg = `Error switching to model ${modelName}: ${error?.message || String(error)}`;
            this.outputChannel.appendLine(errorMsg);
            vscode.window.showErrorMessage(errorMsg);
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await ollama.list();
            return response.models.map((model: any) => model.name);
        } catch (error) {
            this.logError('Error listing models:', error);
            throw error;
        }
    }

    private async prepareModelContext(model: string, task: Task): Promise<string> {
        // Let the template handle most of the context preparation
        // Just provide the essential task-specific information
        if (task.type === 'code' && task.codeContext) {
            return JSON.stringify({
                type: 'code',
                language: task.codeContext.language,
                imports: task.codeContext.imports,
                structure: task.codeContext.structure,
                prompt: task.prompt
            });
        } else if (task.type === 'image') {
            return JSON.stringify({
                type: 'image',
                prompt: task.prompt
            });
        } else {
            return JSON.stringify({
                type: 'general',
                prompt: task.prompt
            });
        }
    }

    public async executeTask(task: Task): Promise<TaskResult> {
        try {
            const startTime = Date.now();
            
            // Get template based on model
            const templateName = this.currentModel === this.CHAT_MODEL ? 'hermes3Template' : 'qwenTemplate';
            const template = this.templates.get(templateName);
            
            if (!template) {
                throw new Error(`Template ${templateName} not found`);
            }

            // Generate prompt using template
            const formattedPrompt = template.generateTaskPrompt({
                prompt: task.prompt,
                previousMessages: this.getConversationContext(this.currentModel),
                systemPrompt: template.systemPrompt
            });

            // Generate response
            const response = await this.generateResponse(formattedPrompt, false);
            
            // Look for tool calls in the response
            const toolCallMatch = response.match(/<tool_call>(.*?)<\/tool_call>/s);
            if (toolCallMatch) {
                this.outputChannel.appendLine('Tool call response detected, processing...');
                this.outputChannel.appendLine('Raw tool call response:');
                this.outputChannel.appendLine(response);
                
                try {
                    const jsonStr = toolCallMatch[1].trim();
                    this.outputChannel.appendLine('Extracted JSON:');
                    this.outputChannel.appendLine(jsonStr);
                    
                    const parsedResponse = JSON.parse(jsonStr);
                    this.outputChannel.appendLine('Parsed response:');
                    this.outputChannel.appendLine(JSON.stringify(parsedResponse, null, 2));
                    
                    if (Array.isArray(parsedResponse.operations)) {
                        // This is a model response with file operations
                        const result = await this.modelCoordinator?.executeModelResponse(parsedResponse);
                        if (!result) {
                            throw new Error('Model coordinator not initialized');
                        }

                        if (result.success) {
                            // Return both the explanation and the operation results
                            return {
                                success: true,
                                data: `${parsedResponse.explanation}\n\nOperations completed:\n${result.results.join('\n')}`,
                                modelUsed: this.currentModel
                            };
                        } else {
                            // Return the error details
                            return {
                                success: false,
                                error: `Failed to complete operations:\n${result.results.join('\n')}`,
                                data: null,
                                modelUsed: this.currentModel
                            };
                        }
                    }
                } catch (e) {
                    const errorMsg = `Error processing tool call: ${e instanceof Error ? e.message : String(e)}`;
                    this.outputChannel.appendLine(errorMsg);
                    return {
                        success: false,
                        error: errorMsg,
                        data: null,
                        modelUsed: this.currentModel
                    };
                }
            }
            
            // If we get here, treat as regular chat response
            return {
                success: true,
                data: response,
                modelUsed: this.currentModel
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logError('Task execution failed:', error);
            return {
                success: false,
                error: errorMsg,
                data: null,
                modelUsed: this.currentModel
            };
        }
    }

    public async generateResponse(prompt: string, stream = true, context?: any[]): Promise<string> {
        try {
            this.outputChannel.appendLine(`Running ${this.currentModel} model with direct generation...`);
            this.outputChannel.appendLine(`Input prompt: ${prompt}`);
            
            // Get appropriate template based on model
            const templateName = this.currentModel === this.CHAT_MODEL ? 'hermes3Template' : 'qwenTemplate';
            const template = this.templates.get(templateName);
            
            if (!template) {
                throw new Error(`Template ${templateName} not found`);
            }

            this.outputChannel.appendLine(`Using template: ${templateName}`);

            // Generate messages using template
            const messages = template.generateTaskPrompt({
                prompt: prompt,
                previousMessages: context || this.getConversationContext(this.currentModel),
                systemPrompt: template.systemPrompt
            });

            this.outputChannel.appendLine(`Generated messages: ${JSON.stringify(messages, null, 2)}`);

            // Validate messages format
            if (!Array.isArray(messages)) {
                throw new Error(`Invalid messages format: expected array but got ${typeof messages}`);
            }

            // Ensure each message has required fields
            const formattedMessages = messages.map((msg: any) => {
                if (!msg.role || !msg.content) {
                    throw new Error(`Invalid message format: each message must have 'role' and 'content'`);
                }
                if (!['system', 'user', 'assistant'].includes(msg.role)) {
                    throw new Error(`Invalid message role: ${msg.role}. Must be 'system', 'user', or 'assistant'`);
                }
                return {
                    role: msg.role,
                    content: msg.content
                };
            });

            this.outputChannel.appendLine(`Sending chat request to ${this.currentModel}`);
            
            const response = await ollama.chat({
                model: this.currentModel,
                messages: formattedMessages
            });

            const fullResponse = response.message.content;
            this.outputChannel.appendLine(`Received response: ${fullResponse}`);

            if (!fullResponse.trim()) {
                throw new Error('Empty response received from model');
            }

            // Validate response if template has validation
            if (template.validateResponse && !template.validateResponse(fullResponse)) {
                this.outputChannel.appendLine('Response failed validation, retrying...');
                return await this.generateResponse(prompt, false, context);
            }

            // Update conversation history with just the user prompt and model response
            if (!this.conversationHistory.has(this.currentModel)) {
                this.conversationHistory.set(this.currentModel, []);
            }
            const history = this.conversationHistory.get(this.currentModel)!;
            history.push({
                role: 'user',
                content: prompt
            });
            history.push({
                role: 'assistant',
                content: fullResponse
            });

            // Trim history if it gets too long
            if (history.length > 10) {
                history.splice(0, history.length - 10);
            }

            return fullResponse;
        } catch (error: any) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logError('Generation failed:', error);
            this.outputChannel.appendLine(`Error details: ${JSON.stringify(error, null, 2)}`);
            throw new Error(`Failed to generate response: ${errorMsg}`);
        }
    }

    public async chat(message: string): Promise<string> {
        try {
            await this.waitForInitialization();
            
            if (!this.ollamaHost) {
                throw new Error('Ollama host not initialized');
            }

            const maxRetries = 3;
            let lastError: any = null;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    await this.ensureModelLoaded(this.currentModel);
                    this.outputChannel.appendLine(`Using model: ${this.currentModel}`);
                    
                    // Match template to model
                    let templateName: string;
                    if (this.currentModel === this.CHAT_MODEL) {
                        templateName = 'hermes3Template';
                    } else if (this.currentModel === this.CODE_MODEL) {
                        templateName = 'qwenTemplate';
                    } else {
                        throw new Error(`No template found for model ${this.currentModel}`);
                    }
                    
                    const template = this.templates.get(templateName);
                    this.outputChannel.appendLine(`Using template: ${templateName}`);
                    
                    if (!template) {
                        throw new Error(`Template ${templateName} not found`);
                    }

                    // Generate messages using template
                    const messages = template.generateTaskPrompt({
                        prompt: message,
                        previousMessages: this.getConversationContext(this.currentModel),
                        systemPrompt: template.systemPrompt
                    });

                    this.outputChannel.appendLine(`Generated messages: ${JSON.stringify(messages, null, 2)}`);

                    // Validate messages format
                    if (!Array.isArray(messages)) {
                        throw new Error(`Invalid messages format: expected array but got ${typeof messages}`);
                    }

                    // Ensure each message has required fields
                    const formattedMessages = messages.map((msg: any) => {
                        if (!msg.role || !msg.content) {
                            throw new Error(`Invalid message format: each message must have 'role' and 'content'`);
                        }
                        if (!['system', 'user', 'assistant'].includes(msg.role)) {
                            throw new Error(`Invalid message role: ${msg.role}. Must be 'system', 'user', or 'assistant'`);
                        }
                        return {
                            role: msg.role,
                            content: msg.content
                        };
                    });

                    let response;
                    try {
                        this.outputChannel.appendLine(`Attempting chat with model name: ${this.currentModel}`);
                        
                        const apiResponse = await fetch(`${this.ollamaHost}/api/chat`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: this.currentModel,
                                messages: formattedMessages,
                                stream: false  // Disable streaming for now
                            })
                        });

                        if (!apiResponse.ok) {
                            const errorText = await apiResponse.text();
                            throw new Error(`API call failed: ${apiResponse.statusText}\n${errorText}`);
                        }

                        response = await apiResponse.json();
                    } catch (chatError: any) {
                        this.outputChannel.appendLine(`Ollama chat error: ${chatError?.message}`);
                        if (chatError?.code === 'ECONNREFUSED') {
                            throw new Error('Connection to Ollama server lost. Please ensure the server is running.');
                        } else if (chatError?.code === 'ETIMEDOUT') {
                            throw new Error('Request to Ollama server timed out. The model may be overloaded.');
                        }
                        throw chatError;
                    }

                    const fullResponse = response.message.content;
                    this.outputChannel.appendLine(`Received response: ${fullResponse}`);
                    
                    // Check if this is a tool call response
                    const toolCallMatch = fullResponse.match(/<tool_call>(.*?)<\/tool_call>/s);
                    if (toolCallMatch) {
                        this.outputChannel.appendLine('Tool call response detected, processing...');
                        this.outputChannel.appendLine('Raw tool call response:');
                        this.outputChannel.appendLine(fullResponse);
                        
                        try {
                            const jsonStr = toolCallMatch[1].trim();
                            this.outputChannel.appendLine('Extracted JSON:');
                            this.outputChannel.appendLine(jsonStr);
                            
                            const parsedResponse = JSON.parse(jsonStr);
                            this.outputChannel.appendLine('Parsed response:');
                            this.outputChannel.appendLine(JSON.stringify(parsedResponse, null, 2));
                            
                            if (Array.isArray(parsedResponse.operations)) {
                                const result = await this.modelCoordinator?.executeModelResponse(parsedResponse);
                                if (!result) {
                                    throw new Error('Model coordinator not initialized');
                                }

                                if (result.success) {
                                    return `${parsedResponse.explanation}\n\nOperations completed:\n${result.results.join('\n')}`;
                                } else {
                                    return `Failed to complete operations:\n${result.results.join('\n')}`;
                                }
                            }
                        } catch (e) {
                            const errorMsg = `Error processing tool call: ${e instanceof Error ? e.message : String(e)}`;
                            this.outputChannel.appendLine(errorMsg);
                            return errorMsg;
                        }
                    }

                    // Update conversation history
                    if (!this.conversationHistory.has(this.currentModel)) {
                        this.conversationHistory.set(this.currentModel, []);
                    }
                    const history = this.conversationHistory.get(this.currentModel)!;
                    history.push({
                        role: 'user',
                        content: message
                    });
                    history.push({
                        role: 'assistant',
                        content: fullResponse
                    });

                    // Trim history if it gets too long
                    if (history.length > 10) {
                        history.splice(0, history.length - 10);
                    }

                    return fullResponse;
                } catch (error: any) {
                    lastError = error;
                    this.outputChannel.appendLine(`Chat attempt ${attempt}/${maxRetries} failed: ${error.message}`);
                    this.outputChannel.appendLine(`Error stack trace: ${error.stack}`);

                    if (attempt < maxRetries) {
                        const delay = attempt * 2000;
                        this.outputChannel.appendLine(`Waiting ${delay}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            throw new Error(`Chat failed after ${maxRetries} attempts: ${lastError?.message}`);
        } catch (error: any) {
            this.logError('Error in chat:', error);
            throw error;
        }
    }

    async analyzeCode(code: string, prompt: string): Promise<string> {
        try {
            // Create a task for code analysis
            const task: Task = {
                id: Math.random().toString(36).substring(7),
                type: 'codeAnalysis',
                prompt: `${prompt}\n\nCode:\n${code}`,
                objective: 'Analyze code and create execution plan',
                requiresModelSwitch: true,
                callback: () => {}
            };

            // Use ModelCoordinator to handle the task
            if (this.modelCoordinator) {
                const result = await this.modelCoordinator.delegateTask(task);
                if (!result?.success) {
                    throw new Error(result?.error || 'Code analysis failed');
                }

                // Return the plan and analysis in a structured format
                const response = {
                    plan: result.plan,
                    analysis: result.analysis,
                    execution: result.execution,
                    response: result.data
                };

                return JSON.stringify(response, null, 2);
            } else {
                // Fallback to direct generation if no ModelCoordinator
                return await this.generateResponse(`${prompt}\n\nCode:\n${code}`, true);
            }
        } catch (error) {
            this.logError('Error analyzing code:', error);
            throw error;
        }
    }

    async proposeFileChanges(files: string[], prompt: string): Promise<FileChange[]> {
        try {
            const fileAnalyses = await Promise.all(
                files.map(async (file) => ({
                    path: file,
                    content: await this.fileSystemService.analyzeFile(file)
                }))
            );

            const task: Task = {
                id: Math.random().toString(36).substring(7),
                type: 'code',
                prompt: `${prompt}\n\nFiles:\n${JSON.stringify(fileAnalyses, null, 2)}`,
                objective: 'Propose file changes',
                requiresModelSwitch: true,
                callback: () => {}
            };

            const result = await this.modelCoordinator?.delegateTask(task);
            
            if (!result?.success) {
                throw new Error(result?.error || 'Failed to propose file changes');
            }
            
            return this.parseFileChanges(result.data);
        } catch (error) {
            this.logError('Error proposing file changes:', error);
            throw error;
        }
    }

    public async analyzeImage(imagePath: string, prompt: string): Promise<string> {
        try {
            await this.ensureModelLoaded(this.VISION_MODEL);
            
            const imageData = await fs.promises.readFile(imagePath, { encoding: 'base64' });
            
            const response = await ollama.chat({
                model: this.VISION_MODEL,
                messages: [{
                    role: 'user',
                    content: prompt,
                    images: [`data:image/jpeg;base64,${imageData}`]
                }],
                stream: false
            });

            return response.message.content;
        } catch (error) {
            this.logError('Error in image analysis:', error);
            throw error;
        }
    }

    async createFile(filePath: string, content: string): Promise<void> {
        try {
            await this.fileSystemService.createFile(filePath, content);
        } catch (error) {
            this.logError('Error creating file:', error);
            throw error;
        }
    }

    async handleFileOperations(changes: FileChange[]): Promise<void> {
        for (const change of changes) {
            try {
                if (!change.filePath) {
                    this.logError('Invalid file change: missing filePath', change);
                    continue;
                }

                if (!change.oldContent && change.newContent) {
                    // This is a create operation
                    await this.createFile(change.filePath, change.newContent);
                } else if (change.newContent) {
                    // This is a modify operation
                    await this.fileSystemService.writeFile(change.filePath, change.newContent);
                }
            } catch (error) {
                this.logError(`Error handling file operation for ${change.filePath}:`, error);
                throw error;
            }
        }
    }

    private async handleStreamResponse(payload: any): Promise<string> {
        try {
            let fullResponse = '';
            
            // Convert payload to ollama chat format
            const response = await ollama.chat({
                ...payload,
                stream: true
            });

            // Handle the stream
            for await (const part of response) {
                if (part.message?.content) {
                    fullResponse += part.message.content;
                    this.outputChannel.appendLine(part.message.content);
                }
            }

            return fullResponse;
        } catch (error) {
            this.outputChannel.appendLine(`Error in stream response: ${error}`);
            throw error;
        }
    }

    private logError(message: string, error: any) {
        this.outputChannel.appendLine(`${message} ${error?.message || String(error)}`);
        console.error(message, error);
    }

    private getConversationContext(model: string): any[] {
        const history = this.conversationHistory.get(model) || [];
        // Only keep last 10 messages to avoid context overflow
        return history.slice(-10);
    }

    getModelState(model: string): ModelState | undefined {
        return this.modelStates.get(model);
    }

    getCurrentModel(): string {
        return this.currentModel;
    }

    private async checkGPUAvailability(): Promise<void> {
        try {
            // Check if NVIDIA GPU is available in Windows
            const checkGPU = require('child_process').spawnSync(
                '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                ['-Command', 'Get-WmiObject Win32_VideoController | Where-Object { $_.Name -like "*NVIDIA*" }'],
                { encoding: 'utf8', windowsHide: true }
            );

            if (checkGPU.stdout && checkGPU.stdout.trim()) {
                this.isGPUAvailable = true;
                this.outputChannel.appendLine('NVIDIA GPU detected, enabling GPU acceleration');
            } else {
                this.isGPUAvailable = false;
                this.outputChannel.appendLine('No NVIDIA GPU detected, using CPU only');
            }
        } catch (error) {
            this.isGPUAvailable = false;
            this.outputChannel.appendLine(`Error checking GPU availability: ${error}`);
        }
    }

    private parseFileChanges(response: string): FileChange[] {
        try {
            const changes: FileChange[] = [];
            let responseObj;
            
            try {
                // Handle case where response includes "Here is the JSON response..." prefix
                const jsonStart = response.indexOf('{');
                const jsonEnd = response.lastIndexOf('}');
                
                if (jsonStart >= 0 && jsonEnd >= 0) {
                    responseObj = JSON.parse(response.substring(jsonStart, jsonEnd + 1));
                } else {
                    responseObj = JSON.parse(response);
                }
            } catch (parseError) {
                this.logError('Error parsing JSON response:', parseError);
                responseObj = { operations: [], changes: [] };
            }

            // Handle both operations and changes arrays
            const operations = responseObj.operations || responseObj.changes || [];
            if (!Array.isArray(operations)) {
                this.outputChannel.appendLine('Warning: Invalid response format - expected operations or changes array');
                return [];
            }

            for (const operation of operations) {
                if (!operation || typeof operation !== 'object') continue;
                
                if (operation.type === 'create') {
                    // Handle create operation
                    changes.push({
                        filePath: operation.filePath,
                        oldContent: '',
                        newContent: operation.content,
                        changes: this.computeLineChanges('', operation.content)
                    });
                } else {
                    // Handle regular file changes
                    changes.push({
                        filePath: operation.path || operation.filePath || '',
                        oldContent: operation.originalContent || '',
                        newContent: operation.modifiedContent || operation.content || '',
                        changes: this.computeLineChanges(
                            operation.originalContent || '',
                            operation.modifiedContent || operation.content || ''
                        )
                    });
                }
            }

            return changes;
        } catch (error) {
            this.logError('Error processing file changes:', error);
            return [];
        }
    }

    private computeLineChanges(oldContent: string, newContent: string): Array<{ lineNumber: number; oldLine: string; newLine: string }> {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const changes: Array<{ lineNumber: number; oldLine: string; newLine: string }> = [];

        let i = 0;
        while (i < Math.max(oldLines.length, newLines.length)) {
            if (oldLines[i] !== newLines[i]) {
                changes.push({
                    lineNumber: i + 1,
                    oldLine: oldLines[i] || '',
                    newLine: newLines[i] || ''
                });
            }
            i++;
        }

        return changes;
    }
}
