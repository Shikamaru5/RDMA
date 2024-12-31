import * as vscode from 'vscode';
import { OllamaService } from './services/ollamaService';
import { ModelCoordinator } from './services/modelCoordinator';
import * as path from 'path';
import { OllamaModel, FileChange } from './types';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating Ollama UI extension...');
    vscode.window.showInformationMessage('Ollama UI extension is now active!');

    const ollamaService = new OllamaService(context);
    
    // Wait for the service to initialize
    try {
        await ollamaService.waitForInitialization();
        console.log('Ollama service initialized successfully');
    } catch (error) {
        console.error('Failed to initialize Ollama service:', error);
        // Continue anyway to allow the UI to be functional
    }

    // Initialize ModelCoordinator as the main orchestrator
    const modelCoordinator = new ModelCoordinator(ollamaService, context);
    ollamaService.setModelCoordinator(modelCoordinator);
    
    let currentPanel: vscode.WebviewPanel | undefined = undefined;

    const models: OllamaModel[] = [
        { name: 'qwen2.5-coder', size: 7, digest: '', modified_at: '', capabilities: ['code', 'instruction'] },
        { name: 'hermes3', size: 8, digest: '', modified_at: '', capabilities: ['instruction', 'conversation'] },
        { name: 'llama3.2-vision', size: 11, digest: '', modified_at: '', capabilities: ['vision', 'instruction'] }
    ];

    // Model selection status bar item
    const modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    modelStatusBarItem.text = "$(symbol-misc) Ollama: hermes3:8b";
    modelStatusBarItem.command = 'ollama.selectModel';
    modelStatusBarItem.show();

    const chatStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    chatStatusBarItem.text = "$(comment-discussion) Ollama Chat";
    chatStatusBarItem.command = 'ollama.startChat';
    chatStatusBarItem.show();

    context.subscriptions.push(modelStatusBarItem, chatStatusBarItem);

    let chatViewProvider: ChatViewProvider | undefined;

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('ollama.selectModel', async () => {
            const models = ['hermes3:8b', 'qwen2.5-coder:7b'];
            const selected = await vscode.window.showQuickPick(models, {
                placeHolder: 'Select an Ollama model'
            });
            if (selected) {
                try {
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `Switching to model ${selected}...`,
                        cancellable: false
                    }, async () => {
                        // Switch the model in OllamaService
                        const success = await ollamaService.switchModel(selected);
                        if (success) {
                            // Only update UI after successful switch
                            context.workspaceState.update('selectedModel', selected);
                            modelStatusBarItem.text = `$(symbol-misc) Ollama: ${selected}`;
                            // Update the chat view if it exists
                            if (chatViewProvider) {
                                await chatViewProvider.setModel(selected);
                            }
                            vscode.window.showInformationMessage(`Successfully switched to ${selected}`);
                        } else {
                            throw new Error(`Failed to switch to ${selected}`);
                        }
                    });
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to switch model: ${error}`);
                }
            }
        }),

        vscode.commands.registerCommand('ollama.startChat', async () => {
            try {
                if (currentPanel) {
                    currentPanel.reveal(vscode.ViewColumn.Beside);
                } else {
                    currentPanel = vscode.window.createWebviewPanel(
                        'ollamaChat',
                        'Ollama Chat',
                        vscode.ViewColumn.Beside,
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true
                        }
                    );

                    // Get the currently selected model from workspace state
                    const currentModel = context.workspaceState.get('selectedModel', 'hermes3:8b');
                    
                    // Create chat provider and ensure it uses the current model
                    chatViewProvider = new ChatViewProvider(context.extensionUri, ollamaService, currentModel);
                    await chatViewProvider.setModel(currentModel);

                    // Set up message handling
                    currentPanel.webview.onDidReceiveMessage(async message => {
                        try {
                            const response = await ollamaService.chat(message.text);
                            currentPanel?.webview.postMessage({ type: 'response', content: response });
                        } catch (error) {
                            vscode.window.showErrorMessage(`Chat error: ${error}`);
                        }
                    });

                    currentPanel.onDidDispose(() => {
                        currentPanel = undefined;
                    });

                    // Set the webview's initial html content
                    currentPanel.webview.html = getChatWebviewContent(context);
                }
            } catch (error) {
                console.error('Error opening chat panel:', error);
                vscode.window.showErrorMessage('Failed to open chat panel');
            }
        })
    );
}

class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _currentModel: string;
    private readonly outputChannel: vscode.OutputChannel;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _ollamaService: OllamaService,
        initialModel: string = 'hermes3:8b'
    ) {
        this._currentModel = initialModel;
        this.outputChannel = vscode.window.createOutputChannel('Ollama Chat');
    }

    public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Ensure we're using the correct model before accepting any messages
        await this._ollamaService.switchModel(this._currentModel);

        webviewView.webview.onDidReceiveMessage(async message => {
            try {
                this.outputChannel.appendLine(`Received message: ${JSON.stringify(message)}`);
                // Use the current model for chat
                const response = await this._ollamaService.chat(message.text);
                this.outputChannel.appendLine(`Response: ${response}`);
                webviewView.webview.postMessage({ type: 'response', content: response });
            } catch (error) {
                this.outputChannel.appendLine(`Error: ${error}`);
                vscode.window.showErrorMessage('Error in chat communication');
            }
        });
    }

    public async setModel(model: string) {
        if (model !== this._currentModel) {
            try {
                const success = await this._ollamaService.switchModel(model);
                if (success) {
                    this._currentModel = model;
                    if (this._view) {
                        this._view.webview.postMessage({ type: 'modelChanged', model });
                    }
                }
            } catch (error) {
                this.outputChannel.appendLine(`Error switching model: ${error}`);
                vscode.window.showErrorMessage(`Failed to switch model: ${error}`);
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Ollama Chat</title>
                <style>
                    body {
                        padding: 0;
                        margin: 0;
                        background: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        font-family: var(--vscode-font-family);
                    }
                    .container {
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        max-width: 100%;
                        margin: 0 auto;
                    }
                    #chat-container {
                        flex: 1;
                        overflow-y: auto;
                        padding: 1rem;
                    }
                    .message {
                        margin: 0.5rem 0;
                        padding: 0.8rem;
                        border-radius: 6px;
                        max-width: 80%;
                    }
                    .user-message {
                        background: var(--vscode-input-background);
                        margin-left: auto;
                        border-bottom-right-radius: 2px;
                    }
                    .assistant-message {
                        background: var(--vscode-editor-inactiveSelectionBackground);
                        margin-right: auto;
                        border-bottom-left-radius: 2px;
                    }
                    .input-container {
                        display: flex;
                        padding: 1rem;
                        background: var(--vscode-editor-background);
                        border-top: 1px solid var(--vscode-widget-border);
                        gap: 0.5rem;
                    }
                    #message-input {
                        flex: 1;
                        padding: 0.5rem;
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                        font-family: var(--vscode-font-family);
                        resize: none;
                        min-height: 2.5em;
                        max-height: 150px;
                    }
                    button {
                        padding: 0.5rem 1rem;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        gap: 0.3rem;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .loading {
                        display: none;
                        margin: 0.5rem 0;
                        padding: 0.5rem;
                        color: var(--vscode-descriptionForeground);
                    }
                    .loading.visible {
                        display: block;
                    }
                    .loading::after {
                        content: '...';
                        animation: dots 1s steps(5, end) infinite;
                    }
                    @keyframes dots {
                        0%, 20% { content: '.'; }
                        40% { content: '..'; }
                        60%, 100% { content: '...'; }
                    }
                    .message pre {
                        background: var(--vscode-textBlockQuote-background);
                        padding: 0.5rem;
                        border-radius: 4px;
                        overflow-x: auto;
                    }
                    .message code {
                        font-family: var(--vscode-editor-font-family);
                    }
                </style>
                <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
            </head>
            <body>
                <div class="container">
                    <div id="chat-container"></div>
                    <div id="loading" class="loading">Hermes3 is thinking</div>
                    <div class="input-container">
                        <textarea 
                            id="message-input" 
                            placeholder="Type a message... (Shift+Enter for new line)"
                            rows="1"
                        ></textarea>
                        <button onclick="sendMessage()">
                            <span>Send</span>
                        </button>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const chatContainer = document.getElementById('chat-container');
                    const messageInput = document.getElementById('message-input');
                    const loadingIndicator = document.getElementById('loading');

                    function addMessage(content, isUser) {
                        const div = document.createElement('div');
                        div.className = \`message \${isUser ? 'user-message' : 'assistant-message'}\`;
                        div.innerHTML = isUser ? content : marked.parse(content);
                        chatContainer.appendChild(div);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }

                    function setLoading(visible) {
                        loadingIndicator.className = \`loading \${visible ? 'visible' : ''}\`;
                    }

                    function sendMessage() {
                        const message = messageInput.value.trim();
                        if (!message) return;

                        addMessage(message, true);
                        setLoading(true);
                        vscode.postMessage({ type: 'chat', message });
                        messageInput.value = '';
                        messageInput.style.height = 'auto';
                    }

                    // Auto-resize textarea
                    messageInput.addEventListener('input', function() {
                        this.style.height = 'auto';
                        this.style.height = (this.scrollHeight) + 'px';
                    });

                    messageInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                        }
                    });

                    window.addEventListener('message', (event) => {
                        const message = event.data;
                        setLoading(false);
                        switch (message.type) {
                            case 'response':
                                addMessage(message.message, false);
                                break;
                            case 'error':
                                addMessage(\`❌ Error: \${message.message}\`, false);
                                break;
                        }
                    });
                </script>
            </body>
        </html>
        `;
    }
}

async function handleImageUpload(imageData: string, panel: vscode.WebviewPanel, service: OllamaService) {
    try {
        const tempPath = path.join(process.cwd(), 'temp_image.png');
        require('fs').writeFileSync(tempPath, Buffer.from(imageData, 'base64'));
        
        const response = await service.analyzeImage(tempPath, 'Analyze this image and describe what you see.');
        panel.webview.postMessage({ type: 'response', content: response });
        
        require('fs').unlinkSync(tempPath);
    } catch (error) {
        vscode.window.showErrorMessage('Error analyzing image');
    }
}

async function handleCodeChanges(files: string[], prompt: string, panel: vscode.WebviewPanel, service: OllamaService) {
                    try {
        const changes = await service.proposeFileChanges(files, prompt);
        await showChangesPreview(changes);
        panel.webview.postMessage({ type: 'diff', content: changes });
                    } catch (error) {
        vscode.window.showErrorMessage('Error proposing changes');
    }
}

async function handleCommandExecution(command: string, panel: vscode.WebviewPanel) {
    const response = await vscode.window.showWarningMessage(
        `Do you want to execute: ${command}?`,
        'Yes', 'No'
    );

    if (response === 'Yes') {
        const terminal = vscode.window.createTerminal('Ollama Command');
        terminal.sendText(command);
        terminal.show();
    }
    panel.webview.postMessage({ type: 'command', content: command });
}

async function showChangesPreview(changes: FileChange[]) {
    for (const change of changes) {
        const uri = vscode.Uri.file(change.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);

        const edit = new vscode.WorkspaceEdit();
        for (const lineChange of change.changes) {
            const range = new vscode.Range(
                new vscode.Position(lineChange.lineNumber - 1, 0),
                new vscode.Position(lineChange.lineNumber, 0)
            );
            edit.replace(uri, range, lineChange.newLine + '\n');
                    }

        await vscode.workspace.applyEdit(edit);
            }
}

function getChatWebviewContent(context: vscode.ExtensionContext): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Ollama Chat</title>
                <style>
                    body {
                        padding: 0;
                        margin: 0;
                        background: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        font-family: var(--vscode-font-family);
                    }
                    .container {
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        max-width: 100%;
                        margin: 0 auto;
                    }
                    .chat-container {
                        flex: 1;
                        overflow-y: auto;
                        padding: 1rem;
                    }
                    .message {
                        margin: 0.5rem 0;
                        padding: 0.5rem;
                        border-radius: 4px;
                    }
                    .user-message {
                        background: var(--vscode-input-background);
                        margin-left: 20%;
                    }
                    .assistant-message {
                        background: var(--vscode-editor-inactiveSelectionBackground);
                        margin-right: 20%;
                    }
                    .input-container {
                        display: flex;
                        padding: 1rem;
                        background: var(--vscode-editor-background);
                        border-top: 1px solid var(--vscode-widget-border);
                    }
                    #messageInput {
                        flex: 1;
                        padding: 0.5rem;
                        margin-right: 0.5rem;
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                    }
                    button {
                        padding: 0.5rem 1rem;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .toolbar {
                        display: flex;
                        padding: 0.5rem;
                        gap: 0.5rem;
                        background: var(--vscode-editor-background);
                        border-bottom: 1px solid var(--vscode-widget-border);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="toolbar">
                        <button onclick="uploadImage()">Upload Image</button>
                        <button onclick="proposeChanges()">Propose Changes</button>
                    </div>
                    <div class="chat-container" id="chatContainer"></div>
                    <div class="input-container">
                        <input type="text" id="messageInput" placeholder="Type a message..." onkeypress="handleKeyPress(event)"/>
                        <button onclick="sendMessage()">Send</button>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const chatContainer = document.getElementById('chatContainer');
                    const messageInput = document.getElementById('messageInput');

                    function addMessage(text, isUser = false) {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message ' + (isUser ? 'user-message' : 'assistant-message');
                        messageDiv.textContent = text;
                        chatContainer.appendChild(messageDiv);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }

                    function sendMessage() {
                        const text = messageInput.value.trim();
                        if (text) {
                            addMessage(text, true);
                            vscode.postMessage({ command: 'chat', text });
                            messageInput.value = '';
                        }
                    }

                    function handleKeyPress(event) {
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            sendMessage();
                        }
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'response':
                                addMessage(message.content);
                                break;
                        }
                    });

                    function uploadImage() {
                        // TODO: Implement image upload
                    }

                    function proposeChanges() {
                        // TODO: Implement code changes proposal
                    }
                </script>
            </body>
        </html>
        `;
}

export function deactivate() {}
