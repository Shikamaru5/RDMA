import * as vscode from 'vscode';
import { spawn, SpawnOptions } from 'child_process';
import { CommandOperation, CommandResult, CommandValidation } from '../types';
import { ModelCoordinator } from './modelCoordinator';

export class CommandService {
    private outputChannel: vscode.OutputChannel;
    private pendingCommands: Map<string, {
        operation: CommandOperation;
        resolve: (value: CommandResult) => void;
        reject: (reason: any) => void;
    }> = new Map();

    constructor(private readonly modelCoordinator: ModelCoordinator) {
        this.outputChannel = vscode.window.createOutputChannel('Command Service');
    }

    async proposeCommand(operation: CommandOperation): Promise<CommandResult> {
        // Validate command before showing proposal
        const validation = await this.validateCommand(operation);
        
        // Create a unique ID for this command proposal
        const proposalId = `cmd_${Date.now()}`;
        
        // Show the command proposal UI with validation results
        const proposal = await this.showCommandProposal(proposalId, operation, validation);
        
        return new Promise((resolve, reject) => {
            this.pendingCommands.set(proposalId, {
                operation,
                resolve,
                reject
            });
        });
    }

    private async showCommandProposal(proposalId: string, operation: CommandOperation, validation: CommandValidation) {
        // Create webview panel for command proposal
        const panel = vscode.window.createWebviewPanel(
            'commandProposal',
            'Command Proposal',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Generate HTML content with command details and approval buttons
        panel.webview.html = this.generateProposalHtml(operation, validation);

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(async message => {
            const pendingCommand = this.pendingCommands.get(proposalId);
            if (!pendingCommand) return;

            switch (message.type) {
                case 'accept':
                    panel.dispose();
                    const result = await this.executeCommand(pendingCommand.operation);
                    pendingCommand.resolve(result);
                    this.pendingCommands.delete(proposalId);
                    break;

                case 'reject':
                    panel.dispose();
                    // Show input box for rejection reason
                    const reason = await vscode.window.showInputBox({
                        prompt: 'Why was this command rejected? (This will help improve future suggestions)',
                        placeHolder: 'Enter reason for rejection...'
                    });
                    
                    // Send feedback to model coordinator for learning
                    if (reason) {
                        await this.modelCoordinator.handleCommandRejection(
                            pendingCommand.operation,
                            reason
                        );
                    }
                    
                    pendingCommand.reject(new Error(`Command rejected: ${reason || 'No reason provided'}`));
                    this.pendingCommands.delete(proposalId);
                    break;
            }
        });
    }

    private async validateCommand(operation: CommandOperation): Promise<CommandValidation> {
        // Check for potentially dangerous commands
        const dangerousPatterns = [
            /rm\s+-rf?\s+\//, // Recursive deletion from root
            />[>]?\s*\/dev\/sd[a-z]/, // Writing to disk devices
            /(^|\s+)dd\s+/, // Direct disk operations
            /mkfs\.[a-z0-9]+\s+\/dev\/sd[a-z]/, // Formatting disks
            /:(){:|:&};:/, // Fork bomb
            /sudo\s+rm\s+-rf?\s+--no-preserve-root\s+\//, // Root deletion with no preserve
        ];
    
        const risks: Array<{level: 'low' | 'medium' | 'high' | 'critical'; description: string}> = [];
        
        // Check for sudo usage
        if (operation.requiresSudo || operation.command.startsWith('sudo ')) {
            risks.push({
                level: 'high',
                description: 'Command requires elevated privileges'
            });
        }
    
        // Check for dangerous patterns
        for (const pattern of dangerousPatterns) {
            if (pattern.test(operation.command)) {
                risks.push({
                    level: 'critical',
                    description: 'Command contains potentially destructive operations'
                });
            }
        }
    
        // Check for network operations
        if (/curl|wget|nc|netcat/.test(operation.command)) {
            risks.push({
                level: 'medium',
                description: 'Command performs network operations'
            });
        }
    
        // Check working directory access
        if (!operation.workingDirectory) {
            risks.push({
                level: 'low',
                description: 'No working directory specified, using current directory'
            });
        }
    
        // Suggest alternatives for risky commands
        const suggestions: string[] = [];
        if (risks.some(r => r.level === 'critical' || r.level === 'high')) {
            suggestions.push('Consider using safer alternatives or more specific paths');
            suggestions.push('Add necessary safeguards and confirmations');
        }
    
        return {
            isValid: !risks.some(r => r.level === 'critical'),
            risks,
            suggestions,
            alternativeCommands: []
        };
    }

    private generateProposalHtml(operation: CommandOperation, validation: CommandValidation): string {
        const riskHtml = validation.risks.map(risk => `
            <li class="risk ${risk.level}">
                ${risk.level.toUpperCase()}: ${risk.description}
            </li>
        `).join('');
    
        // Add null check for suggestions
        const suggestionsHtml = validation.suggestions?.map(suggestion => `
            <li>${suggestion}</li>
        `).join('') || '';
    
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        padding: 10px; 
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                        color: #cccccc;
                        background-color: #1e1e1e;
                    }
                    .command { 
                        background: #2d2d2d;
                        padding: 10px;
                        margin: 10px 0;
                        border-radius: 4px;
                        font-family: 'Courier New', Courier, monospace;
                        border-left: 4px solid #569cd6;
                    }
                    .warning {
                        color: #f97583;
                        margin: 10px 0;
                    }
                    .button-container {
                        display: flex;
                        gap: 10px;
                        margin-top: 20px;
                    }
                    button {
                        padding: 8px 16px;
                        border-radius: 4px;
                        border: none;
                        cursor: pointer;
                        font-size: 14px;
                        transition: opacity 0.2s;
                    }
                    button:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }
                    .accept { 
                        background: #28a745; 
                        color: white; 
                    }
                    .reject { 
                        background: #dc3545; 
                        color: white; 
                    }
                    .risk { 
                        margin: 8px 0;
                        padding: 8px;
                        border-radius: 4px;
                    }
                    .risk.critical { 
                        background-color: rgba(255, 0, 0, 0.1);
                        color: #ff4444;
                        border-left: 4px solid #ff0000;
                    }
                    .risk.high { 
                        background-color: rgba(255, 69, 0, 0.1);
                        color: #ff6b4a;
                        border-left: 4px solid #ff4500;
                    }
                    .risk.medium { 
                        background-color: rgba(255, 165, 0, 0.1);
                        color: #ffa500;
                        border-left: 4px solid #ffa500;
                    }
                    .risk.low { 
                        background-color: rgba(255, 255, 0, 0.1);
                        color: #ffff00;
                        border-left: 4px solid #ffff00;
                    }
                    .details-list {
                        list-style: none;
                        padding: 0;
                    }
                    .details-list li {
                        margin: 8px 0;
                        padding: 8px;
                        background: #2d2d2d;
                        border-radius: 4px;
                    }
                    .suggestions-list {
                        padding-left: 20px;
                    }
                    .suggestions-list li {
                        margin: 4px 0;
                        color: #3794ff;
                    }
                    h2, h3 {
                        color: #ffffff;
                        margin-top: 20px;
                    }
                    .section {
                        margin: 20px 0;
                        padding: 15px;
                        background: #252526;
                        border-radius: 6px;
                    }
                </style>
            </head>
            <body>
                <h2>Command Proposal</h2>
                <div class="section">
                    <div class="command">${operation.command}</div>
                </div>
                
                <div class="section">
                    <h3>Validation Results</h3>
                    ${validation.risks.length > 0 ? `
                        <ul class="details-list">
                            ${riskHtml}
                        </ul>
                    ` : '<p>No risks detected</p>'}
                </div>
                
                ${validation.suggestions?.length ? `
                    <div class="section">
                        <h3>Suggestions</h3>
                        <ul class="suggestions-list">
                            ${suggestionsHtml}
                        </ul>
                    </div>
                ` : ''}
                
                <div class="section">
                    <h3>Details</h3>
                    <ul class="details-list">
                        <li>Working Directory: ${operation.workingDirectory || 'Current'}</li>
                        <li>Type: ${operation.type}</li>
                        ${operation.requiresSudo ? '<li class="warning">Requires elevated privileges</li>' : ''}
                        ${operation.timeout ? `<li>Timeout: ${operation.timeout}ms</li>` : ''}
                    </ul>
                </div>
    
                <div class="button-container">
                    ${validation.isValid ? 
                        `<button class="accept" onclick="accept()">Accept & Execute</button>` :
                        `<button disabled title="Command validation failed">Cannot Execute (Validation Failed)</button>`
                    }
                    <button class="reject" onclick="reject()">Reject & Explain</button>
                </div>
    
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function accept() {
                        vscode.postMessage({ type: 'accept' });
                    }
                    
                    function reject() {
                        vscode.postMessage({ type: 'reject' });
                    }
                </script>
            </body>
            </html>
        `;
    }

    async executeCommand(operation: CommandOperation): Promise<CommandResult> {
        // Validate command first
        const validation = await this.validateCommand(operation);
        
        // If command is invalid, reject with validation details
        if (!validation.isValid) {
            throw new Error(`Command validation failed: ${validation.risks.map(r => r.description).join(', ')}`);
        }
    
        // If there are high risks, require additional confirmation
        const highRisks = validation.risks.filter(r => r.level === 'high');
        if (highRisks.length > 0) {
            const confirm = await vscode.window.showWarningMessage(
                `This command has high risks:\n${highRisks.map(r => r.description).join('\n')}\n\nDo you want to proceed?`,
                { modal: true },
                'Yes, Execute',
                'No, Cancel'
            );
            
            if (confirm !== 'Yes, Execute') {
                throw new Error('Command execution cancelled due to high risks');
            }
        }
    
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            const startTime = Date.now();
    
            const options: SpawnOptions = {
                shell: true,
                cwd: operation.workingDirectory || process.cwd(),
                env: {
                    ...process.env,
                    ...operation.environment
                }
            };
    
            // Split command into parts for spawn
            const [cmd, ...args] = operation.command.split(' ');
            const proc = spawn(cmd, args, options);
    
            if (proc.stdout) {
                proc.stdout.on('data', (data) => {
                    const text = data.toString();
                    stdout += text;
                    this.outputChannel.append(text);
                });
            }
    
            if (proc.stderr) {
                proc.stderr.on('data', (data) => {
                    const text = data.toString();
                    stderr += text;
                    this.outputChannel.append(text);
                });
            }
    
            proc.on('close', (code) => {
                const duration = Date.now() - startTime;
                resolve({
                    success: code === 0,
                    stdout,
                    stderr,
                    exitCode: code ?? 1, // Default to 1 if code is null
                    duration,
                    command: operation.command,
                    workingDirectory: operation.workingDirectory || process.cwd()
                });
            });
    
            proc.on('error', (error) => {
                reject(error);
            });
        });
    }
}