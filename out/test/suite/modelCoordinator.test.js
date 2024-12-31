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
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const modelCoordinator_1 = require("../../services/modelCoordinator");
const ollamaService_1 = require("../../services/ollamaService");
const events_1 = require("events");
function createMockEvent() {
    const emitter = new events_1.EventEmitter();
    const event = (listener, disposables) => {
        const disposable = {
            dispose: () => {
                emitter.removeListener('event', listener);
            }
        };
        if (disposables) {
            disposables.push(disposable);
        }
        emitter.on('event', listener);
        return disposable;
    };
    // Add the fire method for testing
    event.fire = (data) => {
        emitter.emit('event', data);
    };
    return event;
}
suite('ModelCoordinator Test Suite', () => {
    let mockContext;
    let modelCoordinator;
    let ollamaService;
    let mockOutputChannel;
    suiteSetup(async function () {
        // This hook runs once before all tests
        this.timeout(120000); // Allow 2 minutes for initial setup including model loading
        // Create output channel that actually logs
        mockOutputChannel = {
            append: (msg) => console.log(msg),
            appendLine: (msg) => console.log(msg),
            clear: () => { },
            dispose: () => { },
            hide: () => { },
            show: () => { },
            replace: (value) => { },
            name: 'Test Channel'
        };
        // Create context with minimal mocking
        mockContext = {
            subscriptions: [],
            workspaceState: {
                get: () => undefined,
                update: () => Promise.resolve(),
                keys: () => []
            },
            globalState: {
                get: () => undefined,
                update: () => Promise.resolve(),
                keys: () => [],
                setKeysForSync: () => { }
            },
            extensionPath: __dirname,
            storagePath: path.join(__dirname, '.storage'),
            globalStoragePath: path.join(__dirname, '.global-storage'),
            logPath: path.join(__dirname, '.log'),
            extensionUri: vscode.Uri.file(__dirname),
            environmentVariableCollection: {
                persistent: true,
                replace: () => { },
                append: () => { },
                prepend: () => { },
                get: () => undefined,
                forEach: () => { },
                delete: () => { },
                clear: () => { },
                [Symbol.iterator]: function* () { yield* []; }
            },
            extensionMode: vscode.ExtensionMode.Development,
            storageUri: vscode.Uri.file(path.join(__dirname, '.storage')),
            globalStorageUri: vscode.Uri.file(path.join(__dirname, '.global-storage')),
            logUri: vscode.Uri.file(path.join(__dirname, '.log')),
            asAbsolutePath: (p) => path.join(__dirname, p),
            extension: {
                id: 'test.extension',
                extensionUri: vscode.Uri.file(__dirname),
                extensionPath: __dirname,
                isActive: true,
                packageJSON: {},
                extensionKind: vscode.ExtensionKind.Workspace,
                exports: undefined
            },
            createOutputChannel: () => mockOutputChannel
        };
        // Initialize services
        ollamaService = new ollamaService_1.OllamaService(mockContext);
        try {
            // Wait for service initialization
            await ollamaService.waitForInitialization();
            // Initialize ModelCoordinator
            modelCoordinator = new modelCoordinator_1.ModelCoordinator(ollamaService, mockContext);
            // Explicitly switch to initial model like the chat panel does
            const modelSwitched = await ollamaService.switchModel('hermes3:8b');
            if (!modelSwitched) {
                throw new Error('Failed to switch to initial model');
            }
            console.log('Test environment successfully initialized');
        }
        catch (error) {
            console.error('Test setup failed:', error);
            throw error;
        }
    });
    test('General chat capability', async function () {
        this.timeout(30000); // Allow 30 seconds for chat response
        const result = await modelCoordinator.handleTask('Explain what a fibonacci sequence is in simple terms');
        assert.ok(result, 'Should return a response');
    });
    test('Code generation capability', async function () {
        this.timeout(30000); // Allow 30 seconds for code generation
        const result = await modelCoordinator.handleTask('Write a TypeScript function that implements binary search');
        assert.ok(result, 'Should return generated code');
    });
    test('Code analysis capability', async function () {
        this.timeout(30000); // Allow 30 seconds for code analysis
        const result = await modelCoordinator.handleTask('Analyze this code and suggest improvements:\n' +
            'function add(a,b) { return a + b; }');
        assert.ok(result, 'Should return code analysis');
    });
    test('Model switching', async function () {
        this.timeout(30000); // Allow 30 seconds for model switching
        const result = await modelCoordinator.handleTask('Switch to model:codellama');
        assert.ok(result, 'Should return confirmation of model switch');
    });
});
//# sourceMappingURL=modelCoordinator.test.js.map