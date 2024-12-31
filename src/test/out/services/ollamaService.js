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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaService = void 0;
const axios_1 = __importDefault(require("axios"));
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fileSystemService_1 = require("./fileSystemService");
class OllamaService {
    constructor(context) {
        this.WSL_HOST = '172.27.208.1';
        this.baseUrls = [
            `http://${this.WSL_HOST}:11434`, // Windows host IP from WSL
            'http://[::1]:11434', // IPv6 localhost
            'http://127.0.0.1:11434', // IPv4 localhost
            'http://localhost:11434', // hostname
            'http://0.0.0.0:11434' // any interface
        ];
        this.baseUrl = '';
        this.CHAT_MODEL = 'hermes3:8b';
        this.CODE_MODEL = 'qwen2.5-coder:7b';
        this.VISION_MODEL = 'llama3.2-vision:11b';
        this.SYSTEM_PROMPT = 'You are a helpful AI assistant. Respond directly and professionally to questions without roleplaying or adding asterisk actions.';
        this.isModelRunning = false;
        this.modelStates = new Map();
        this.taskQueue = [];
        this.currentTask = null;
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('Ollama Service');
        this.outputChannel.show();
        this.conversationHistory = new Map();
        this.fileSystemService = new fileSystemService_1.FileSystemService();
        this.currentModel = this.CHAT_MODEL;
        this.client = axios_1.default.create({
            timeout: 60000
        });
        this.modelClient = axios_1.default.create({
            timeout: 300000
        });
        this.initializationPromise = this.initializeService();
    }
    async initializeService() {
        try {
            this.outputChannel.appendLine('Initializing Ollama service...');
            // First, ensure Ollama server is running
            await this.startOllamaServer();
            // Update client with new baseUrl and longer timeout
            this.client = axios_1.default.create({
                baseURL: this.baseUrl,
                timeout: 30000
            });
            // Just verify server is running with a version check
            await this.client.get('/api/version');
            this.outputChannel.appendLine('Ollama server is running');
        }
        catch (error) {
            const errorMessage = `Failed to initialize Ollama service: ${error?.message}`;
            this.outputChannel.appendLine(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
            throw error;
        }
    }
    async waitForInitialization() {
        return this.initializationPromise;
    }
    async startOllamaServer() {
        try {
            this.outputChannel.appendLine('Starting Ollama server...');
            // First, check if process is running and stop it
            const checkProcess = require('child_process').spawnSync('powershell.exe', ['-Command', 'Get-Process ollama -ErrorAction SilentlyContinue'], { encoding: 'utf8' });
            if (checkProcess.stdout && checkProcess.stdout.trim()) {
                this.outputChannel.appendLine('Ollama process found, stopping it...');
                require('child_process').spawnSync('powershell.exe', ['-Command', 'Stop-Process -Name ollama -Force']);
                // Wait for process to terminate
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            // Start the Ollama server
            const startCmd = require('child_process').spawn('powershell.exe', [
                '-Command',
                `
                    $env:OLLAMA_HOST = '0.0.0.0:11434'
                    $env:OLLAMA_ORIGINS = '*'
                    cd 'C:\\Users\\Kalvin\\AppData\\Local\\Programs\\Ollama'
                    
                    $process = Start-Process -FilePath .\\ollama.exe -ArgumentList 'serve' -PassThru -NoNewWindow -RedirectStandardOutput ollama.log -RedirectStandardError ollama.error.log
                    
                    Write-Host "Started Ollama process with ID: $($process.Id)"
                    
                    Wait-Process -Id $process.Id
                    `
            ], { stdio: ['inherit', 'pipe', 'pipe'] });
            startCmd.stdout?.on('data', (data) => {
                const output = data.toString().trim();
                if (output) {
                    this.outputChannel.appendLine('Ollama startup: ' + output);
                }
            });
            startCmd.stderr?.on('data', (data) => {
                const error = data.toString().trim();
                if (error) {
                    this.outputChannel.appendLine('Ollama error: ' + error);
                }
            });
            // Wait for initial startup
            await new Promise(resolve => setTimeout(resolve, 5000));
            // Try to connect using each host configuration
            const hosts = [
                { hostname: this.WSL_HOST, family: 4 },
                { hostname: '127.0.0.1', family: 4 },
                { hostname: '::1', family: 6 },
                { hostname: 'localhost', family: 0 }
            ];
            for (const host of hosts) {
                try {
                    const response = await this.client.get(`http://${host.hostname}:11434/api/version`, {
                        timeout: 5000,
                        headers: { 'Host': 'localhost' }
                    });
                    if (response.status === 200) {
                        this.baseUrl = `http://${host.hostname}:11434`;
                        this.isModelRunning = true;
                        this.outputChannel.appendLine(`Connected to Ollama at ${this.baseUrl}`);
                        return;
                    }
                }
                catch (error) {
                    continue;
                }
            }
            throw new Error('Could not connect to Ollama server');
        }
        catch (error) {
            this.isModelRunning = false;
            this.outputChannel.appendLine(`Failed to start Ollama server: ${error.message}`);
            throw error;
        }
    }
    async cleanupZombieProcesses() {
        try {
            const findProcess = require('child_process').spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-Command', 'Get-Process -Name ollama -ErrorAction SilentlyContinue | Stop-Process -Force'], { windowsHide: true });
            if (findProcess.stderr) {
                const error = findProcess.stderr.toString().trim();
                if (error && !error.includes('Cannot find a process')) {
                    this.outputChannel.appendLine(`Warning during process cleanup: ${error}`);
                }
            }
            // Wait a bit for cleanup
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        catch (error) {
            this.outputChannel.appendLine(`Warning: Error during process cleanup: ${error}`);
        }
    }
    async validateConnection() {
        const hosts = [
            { hostname: this.WSL_HOST, family: 4 },
            { hostname: '127.0.0.1', family: 4 },
            { hostname: '::1', family: 6 },
            { hostname: 'localhost', family: 0 }
        ];
        for (const host of hosts) {
            try {
                const testUrl = `http://${host.hostname}:11434/api/version`;
                const response = await this.client.get(testUrl, {
                    timeout: 2000,
                    headers: { 'Host': 'localhost' }
                });
                if (response.status === 200) {
                    this.baseUrl = `http://${host.hostname}:11434`;
                    this.isModelRunning = true;
                    return;
                }
            }
            catch (error) {
                continue;
            }
        }
        throw new Error('Could not establish connection to Ollama server');
    }
    async detectWindowsHostIp() {
        try {
            const result = await require('child_process').spawnSync('ip', ['route', 'show'], { encoding: 'utf8' });
            const match = result.stdout.match(/default via ([\d.]+)/);
            return match ? match[1] : null;
        }
        catch (error) {
            this.outputChannel.appendLine('Failed to detect Windows host IP, using default');
            return null;
        }
    }
    async ensureModelPulledWithRetry(modelName, maxRetries = 3) {
        let retries = maxRetries;
        while (retries >= 0) {
            try {
                this.outputChannel.appendLine(`Checking if model ${modelName} is available (attempt ${maxRetries - retries + 1}/${maxRetries + 1})...`);
                const models = await this.listModels();
                if (!models.includes(modelName)) {
                    this.outputChannel.appendLine(`Model ${modelName} not found. Pulling...`);
                    const pullResponse = await this.client.post('/api/pull', { name: modelName });
                    if (pullResponse.status === 200) {
                        this.outputChannel.appendLine(`Successfully pulled model ${modelName}`);
                        return;
                    }
                }
                else {
                    this.outputChannel.appendLine(`Model ${modelName} is already available`);
                    return;
                }
            }
            catch (error) {
                retries--;
                if (retries < 0) {
                    throw new Error(`Failed to ensure model ${modelName} is available after ${maxRetries + 1} attempts: ${error.message}`);
                }
                this.outputChannel.appendLine(`Failed to pull model ${modelName}, retrying... (${retries + 1} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    async findRunningOllamaProcess() {
        try {
            // Check if port 11434 is in use first
            const findPort = require('child_process').spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
                '-Command',
                'Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue'
            ], {
                encoding: 'utf8',
                windowsHide: true
            });
            if (findPort.stdout?.includes('11434')) {
                this.outputChannel.appendLine('Found Ollama port 11434 in use');
                return true;
            }
            // If port is not in use, check for the process
            const findProcess = require('child_process').spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
                '-Command',
                'Get-Process -Name ollama -ErrorAction SilentlyContinue'
            ], {
                encoding: 'utf8',
                windowsHide: true
            });
            if (findProcess.stdout?.includes('ollama')) {
                // Process exists but port is not in use, might need to kill it
                const pid = findProcess.stdout.match(/(\d+)\s+ollama/)?.[1];
                if (pid) {
                    this.outputChannel.appendLine(`Found zombie Ollama process (PID: ${pid}), killing it...`);
                    require('child_process').spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
                        '-Command',
                        `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`
                    ]);
                }
            }
            return false;
        }
        catch (error) {
            this.outputChannel.appendLine(`Error checking for running Ollama process: ${error}`);
            return false;
        }
    }
    async checkOllamaStatus() {
        try {
            // Check if port is actually in use using PowerShell
            const findPort = require('child_process').spawnSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
                '-Command',
                'Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue'
            ], {
                encoding: 'utf8',
                windowsHide: true
            });
            const isPortInUse = findPort.stdout?.includes('11434');
            if (!isPortInUse) {
                this.outputChannel.appendLine('Port 11434 is not in use, Ollama server is not running');
                this.isModelRunning = false;
                throw new Error('Ollama server is not running');
            }
            // Try connecting using the WSL host IP
            const response = await this.client.get('/api/version', {
                timeout: 2000,
                headers: {
                    'Host': 'localhost'
                }
            });
            this.outputChannel.appendLine(`Ollama version: ${JSON.stringify(response.data)}`);
            this.isModelRunning = true;
            return true;
        }
        catch (error) {
            this.isModelRunning = false;
            if (error?.code === 'ECONNREFUSED') {
                this.outputChannel.appendLine(`Connection refused to ${this.baseUrl}, Ollama server is not running`);
            }
            else if (error?.code === 'ETIMEDOUT') {
                this.outputChannel.appendLine('Connection timed out, Ollama server might be starting up');
            }
            else {
                this.outputChannel.appendLine(`Error checking Ollama status: ${error?.message}`);
            }
            throw error;
        }
    }
    async ensureModelPulled(modelName) {
        try {
            this.outputChannel.appendLine(`Checking if model ${modelName} is available...`);
            // First check if model exists
            const models = await this.listModels();
            if (!models.includes(modelName)) {
                this.outputChannel.appendLine(`Model ${modelName} not found. Pulling...`);
                const pullResponse = await this.client.post('/api/pull', {
                    name: modelName,
                    stream: true
                }, {
                    responseType: 'stream'
                });
                // Handle pull progress
                await new Promise((resolve, reject) => {
                    pullResponse.data.on('data', (chunk) => {
                        try {
                            const lines = chunk.toString().split('\n').filter((line) => line.trim());
                            for (const line of lines) {
                                try {
                                    const json = JSON.parse(line);
                                    if (json.status) {
                                        this.outputChannel.appendLine(`Pull status: ${json.status}`);
                                    }
                                }
                                catch (e) {
                                    // Skip invalid JSON
                                }
                            }
                        }
                        catch (e) {
                            // Skip invalid chunks
                        }
                    });
                    pullResponse.data.on('end', resolve);
                    pullResponse.data.on('error', reject);
                });
                this.outputChannel.appendLine(`Successfully pulled model ${modelName}`);
            }
            // Verify model is ready
            const modelInfo = await this.client.get(`/api/show`, {
                params: { name: modelName }
            });
            if (!modelInfo.data?.status?.includes('ready')) {
                throw new Error(`Model ${modelName} exists but is not ready`);
            }
            this.outputChannel.appendLine(`Model ${modelName} is ready`);
        }
        catch (error) {
            const errorMsg = `Failed to ensure model ${modelName} is available: ${error?.message || String(error)}`;
            this.outputChannel.appendLine(errorMsg);
            throw new Error(errorMsg);
        }
    }
    async ensureModelLoaded(modelName) {
        try {
            this.outputChannel.appendLine(`Testing ${modelName} model...`);
            await this.modelClient.post(`${this.baseUrl}/api/generate`, {
                model: modelName,
                prompt: '',
                stream: false
            });
            this.outputChannel.appendLine(`Model ${modelName} is ready`);
        }
        catch (error) {
            const errorMsg = `Failed to load model ${modelName}: ${error?.message || String(error)}`;
            this.outputChannel.appendLine(errorMsg);
            throw new Error(errorMsg);
        }
    }
    async unloadCurrentModel() {
        if (!this.currentModel)
            return;
        try {
            this.outputChannel.appendLine(`Unloading model ${this.currentModel}...`);
            await this.client.delete(`${this.baseUrl}/api/show`, {
                params: { name: this.currentModel }
            });
            this.isModelRunning = false;
            this.modelStates.set(this.currentModel, {
                isRunning: false,
                lastUsed: new Date()
            });
        }
        catch (error) {
            this.outputChannel.appendLine(`Warning: Failed to unload model ${this.currentModel}: ${error}`);
            // Continue anyway as the model might not be loaded
        }
    }
    async switchModel(modelName) {
        try {
            // First unload current model
            await this.unloadCurrentModel();
            // Verify model exists
            await this.client.get(`${this.baseUrl}/api/show`, {
                params: { name: modelName }
            });
            // Load the new model
            this.outputChannel.appendLine(`Loading model ${modelName}...`);
            await this.client.post(`${this.baseUrl}/api/generate`, {
                model: modelName,
                prompt: '', // Empty prompt to load model
                stream: false
            });
            this.currentModel = modelName;
            this.isModelRunning = true;
            this.modelStates.set(modelName, {
                isRunning: true,
                lastUsed: new Date()
            });
            this.outputChannel.appendLine(`Successfully switched to model ${modelName}`);
            return true;
        }
        catch (error) {
            const errorMsg = `Failed to switch to model ${modelName}: ${error}`;
            this.outputChannel.appendLine(errorMsg);
            vscode.window.showErrorMessage(errorMsg);
            return false;
        }
    }
    async prepareModelContext(model, task) {
        let context = '';
        if (task.type === 'code' && task.codeContext) {
            context = `You are a code assistant specializing in ${task.codeContext.language} development.
Your task is to generate, analyze, or modify code while:
1. Following ${task.codeContext.language} best practices and conventions
2. Maintaining consistent style with the existing codebase
3. Properly handling imports and dependencies
4. Ensuring type safety and error handling
5. Writing clear, maintainable, and efficient code

Current file context:
- Language: ${task.codeContext.language}
- Current imports: ${task.codeContext.imports.join(', ')}
- File structure:
${JSON.stringify(task.codeContext.structure, null, 2)}

Instructions for the task:
${task.prompt}`;
        }
        else if (model === this.CODE_MODEL) {
            context = `You are a code assistant. Generate clear, efficient, and well-documented code.
Task: ${task.prompt}`;
        }
        else if (model === this.VISION_MODEL) {
            context = `You are a computer vision assistant. Analyze images and provide detailed descriptions.
Task: ${task.prompt}`;
        }
        else {
            context = `You are a helpful AI assistant. ${this.SYSTEM_PROMPT}
Task: ${task.prompt}`;
        }
        return context;
    }
    async generateCompletion(model, prompt) {
        try {
            const response = await this.modelClient.post(`${this.baseUrl}/api/generate`, {
                model: model,
                prompt: prompt,
                stream: false
            });
            return response.data.response;
        }
        catch (error) {
            this.outputChannel.appendLine(`Error generating completion: ${error}`);
            throw error;
        }
    }
    async executeTask(task) {
        const model = this.modelStates.get(this.currentModel);
        if (!model?.isRunning) {
            throw new Error(`Model ${this.currentModel} is not running`);
        }
        try {
            const context = await this.prepareModelContext(this.currentModel, task);
            const response = await this.generateCompletion(this.currentModel, context);
            if (task.type === 'code' && task.codeContext) {
                // For code tasks, validate the response format
                try {
                    const codeBlocks = this.extractCodeBlocks(response);
                    if (codeBlocks.length === 0) {
                        throw new Error('No code blocks found in response');
                    }
                    return {
                        success: true,
                        data: codeBlocks[0],
                        modelUsed: this.currentModel
                    };
                }
                catch (error) {
                    this.outputChannel.appendLine(`Code extraction failed: ${error}`);
                    return {
                        success: true,
                        data: response,
                        modelUsed: this.currentModel
                    };
                }
            }
            return {
                success: true,
                data: response,
                modelUsed: this.currentModel
            };
        }
        catch (error) {
            this.outputChannel.appendLine(`Task execution failed: ${error}`);
            return {
                success: false,
                data: null,
                error: error.message,
                modelUsed: this.currentModel
            };
        }
    }
    extractCodeBlocks(response) {
        const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
        const blocks = [];
        let match;
        while ((match = codeBlockRegex.exec(response)) !== null) {
            blocks.push(match[1].trim());
        }
        return blocks;
    }
    async listModels() {
        try {
            const response = await this.client.get('/api/tags');
            return response.data.models.map((model) => model.name);
        }
        catch (error) {
            this.logError('Error listing models:', error);
            throw error;
        }
    }
    async generateResponse(model, prompt, stream = true, context) {
        try {
            const response = await this.client.post('/api/generate', {
                model: model,
                prompt: prompt,
                stream: stream,
                context: context || []
            }, {
                responseType: stream ? 'stream' : undefined
            });
            if (!stream) {
                return response.data.response;
            }
            let fullResponse = '';
            for await (const chunk of response.data) {
                const lines = chunk.toString().split('\n').filter((line) => line.trim());
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.response) {
                            fullResponse += parsed.response;
                            this.outputChannel.appendLine(parsed.response);
                        }
                    }
                    catch (e) {
                        // Skip invalid JSON
                    }
                }
            }
            return fullResponse;
        }
        catch (error) {
            this.outputChannel.appendLine(`Error generating response: ${error.message}`);
            throw error;
        }
    }
    async analyzeCode(code, prompt) {
        try {
            await this.switchModel(this.CODE_MODEL);
            const response = await this.generateResponse(this.CODE_MODEL, `${prompt}\n\nCode:\n${code}`);
            return response;
        }
        catch (error) {
            this.logError('Error analyzing code:', error);
            throw error;
        }
    }
    async proposeFileChanges(files, prompt) {
        try {
            await this.switchModel(this.CODE_MODEL);
            const fileAnalyses = await Promise.all(files.map(async (file) => ({
                path: file,
                content: await this.fileSystemService.analyzeFile(file)
            })));
            const response = await this.generateResponse(this.CODE_MODEL, `${prompt}\n\nFiles:\n${JSON.stringify(fileAnalyses, null, 2)}`);
            return this.parseFileChanges(response);
        }
        catch (error) {
            this.logError('Error proposing file changes:', error);
            throw error;
        }
    }
    async analyzeImage(imagePath, prompt) {
        try {
            await this.switchModel(this.VISION_MODEL);
            const imageData = await fs.promises.readFile(imagePath);
            const base64Image = imageData.toString('base64');
            const response = await this.client.post('/api/generate', {
                model: this.VISION_MODEL,
                prompt,
                images: [base64Image]
            });
            return response.data.response;
        }
        catch (error) {
            this.logError('Error analyzing image:', error);
            throw error;
        }
    }
    async createFile(filePath, content) {
        // First analyze the workspace for similar files
        const workspaceAnalysis = await this.fileSystemService.analyzeWorkspaceForFile(filePath);
        // If similar files exist, we should warn and possibly suggest a better location
        if (workspaceAnalysis.similarFiles.length > 0) {
            const similarFiles = workspaceAnalysis.similarFiles
                .map(f => `${f.path} (${f.reason})`)
                .join('\n');
            const message = `Found similar files in the workspace:\n${similarFiles}`;
            if (workspaceAnalysis.suggestedLocation) {
                const suggestedPath = path.join(workspaceAnalysis.suggestedLocation, path.basename(filePath));
                throw new Error(`${message}\n\nSuggested location: ${suggestedPath}`);
            }
            else {
                throw new Error(message);
            }
        }
        const validation = await this.fileSystemService.validateFileOperation('create', filePath);
        if (!validation.safe) {
            throw new Error(`Cannot create file: ${validation.reason}`);
        }
        // Analyze parent directory
        const parentDir = path.dirname(filePath);
        const parentAnalysis = await this.fileSystemService.analyzeFile(parentDir);
        if (!parentAnalysis.exists) {
            throw new Error('Parent directory does not exist');
        }
        if (!parentAnalysis.permissions?.writable) {
            throw new Error('Cannot write to parent directory');
        }
        await fs.promises.writeFile(filePath, content, 'utf-8');
    }
    async editFile(filePath, changes) {
        // Analyze workspace to check if we're editing the right file
        const workspaceAnalysis = await this.fileSystemService.analyzeWorkspaceForFile(filePath);
        // If there are similar files, we should warn about them
        if (workspaceAnalysis.similarFiles.length > 0) {
            const similarFiles = workspaceAnalysis.similarFiles
                .map(f => `${f.path} (${f.reason})`)
                .join('\n');
            // Just warn in this case since we're editing an existing file
            this.outputChannel.appendLine(`Warning: Found similar files in the workspace:\n${similarFiles}`);
        }
        const validation = await this.fileSystemService.validateFileOperation('write', filePath);
        if (!validation.safe) {
            throw new Error(`Cannot edit file: ${validation.reason}`);
        }
        const analysis = await this.fileSystemService.analyzeFile(filePath);
        if (!analysis.content) {
            throw new Error('Cannot read file content');
        }
        // TODO: Implement proper diff and patch logic
        await fs.promises.writeFile(filePath, changes, 'utf-8');
    }
    async chat(message) {
        try {
            this.outputChannel.appendLine('\n--- Starting chat request ---');
            this.outputChannel.appendLine(`User message: ${message}`);
            const response = await this.generateResponse(this.currentModel, message, true);
            // Update conversation history
            const history = this.conversationHistory.get(this.currentModel) || [];
            history.push({ role: 'user', content: message });
            history.push({ role: 'assistant', content: response });
            this.conversationHistory.set(this.currentModel, history);
            return response;
        }
        catch (error) {
            const errorMessage = error?.response?.data?.error || error?.message || 'Unknown error';
            this.outputChannel.appendLine(`Error in chat: ${errorMessage}`);
            this.outputChannel.appendLine(`Full error: ${JSON.stringify(error)}`);
            if (error?.code === 'ECONNREFUSED') {
                const msg = 'Cannot connect to Ollama. Please ensure the Ollama service is running on your Windows system.';
                this.outputChannel.appendLine(msg);
                vscode.window.showErrorMessage(msg);
            }
            else {
                vscode.window.showErrorMessage(`Chat error: ${errorMessage}`);
            }
            throw error;
        }
    }
    setModelCoordinator(coordinator) {
        this.modelCoordinator = coordinator;
    }
    parseFileChanges(response) {
        try {
            const changes = [];
            let responseObj;
            try {
                responseObj = JSON.parse(response);
            }
            catch (parseError) {
                this.logError('Error parsing JSON response:', parseError);
                responseObj = { changes: [] };
            }
            if (!responseObj || !Array.isArray(responseObj.changes)) {
                this.outputChannel.appendLine('Warning: Invalid response format for file changes');
                return [];
            }
            for (const file of responseObj.changes) {
                if (!file || typeof file !== 'object')
                    continue;
                changes.push({
                    filePath: file.path || '',
                    oldContent: file.originalContent || '',
                    newContent: file.modifiedContent || '',
                    changes: this.computeLineChanges(file.originalContent || '', file.modifiedContent || '')
                });
            }
            return changes;
        }
        catch (error) {
            this.logError('Error processing file changes:', error);
            return [];
        }
    }
    computeLineChanges(oldContent, newContent) {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const changes = [];
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
    getConversationContext(model) {
        return this.conversationHistory.get(model) || [];
    }
    async handleStreamResponse(payload) {
        try {
            const response = await this.client.post('/api/generate', payload, {
                responseType: 'stream'
            });
            let fullResponse = '';
            for await (const chunk of response.data) {
                const lines = chunk.toString().split('\n').filter((line) => line.trim());
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.response) {
                            fullResponse += parsed.response;
                            this.outputChannel.appendLine(parsed.response);
                        }
                    }
                    catch (e) {
                        // Skip invalid JSON
                    }
                }
            }
            return fullResponse;
        }
        catch (error) {
            this.outputChannel.appendLine(`Error in stream response: ${error}`);
            throw error;
        }
    }
    logError(message, error) {
        this.outputChannel.appendLine(`${message} ${error?.message || String(error)}`);
        console.error(message, error);
    }
    getModelState(model) {
        return this.modelStates.get(model);
    }
    getCurrentModel() {
        return this.currentModel;
    }
}
exports.OllamaService = OllamaService;
//# sourceMappingURL=ollamaService.js.map