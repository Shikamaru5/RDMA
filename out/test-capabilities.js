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
const vscode = __importStar(require("vscode"));
const modelCoordinator_1 = require("./services/modelCoordinator");
const ollamaService_1 = require("./services/ollamaService");
const events_1 = require("events");
function createMockEvent() {
    const emitter = new events_1.EventEmitter();
    const event = (listener, thisArgs, disposables) => {
        const bound = thisArgs ? listener.bind(thisArgs) : listener;
        emitter.on('event', bound);
        const disposable = {
            dispose: () => {
                emitter.removeListener('event', bound);
            }
        };
        if (disposables) {
            disposables.push(disposable);
        }
        return disposable;
    };
    // Add the fire method for testing
    event.fire = (data) => {
        emitter.emit('event', data);
    };
    return event;
}
// Mock vscode.ExtensionContext
const mockContext = {
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
    extensionPath: '/mock/extension/path',
    storagePath: '/mock/storage/path',
    globalStoragePath: '/mock/global/storage/path',
    logPath: '/mock/log/path',
    extensionUri: vscode.Uri.file('/mock/extension/path'),
    globalStorageUri: vscode.Uri.file('/mock/global/storage/path'),
    logUri: vscode.Uri.file('/mock/log/path'),
    asAbsolutePath: (relativePath) => `/mock/extension/path/${relativePath}`,
    environmentVariableCollection: {
        persistent: true,
        description: 'Mock Environment Variables',
        replace: () => { },
        append: () => { },
        prepend: () => { },
        get: () => undefined,
        forEach: () => { },
        delete: () => { },
        clear: () => { },
        getScoped: () => ({}),
        [Symbol.iterator]: function* () { yield* []; }
    },
    extensionMode: vscode.ExtensionMode.Development,
    storageUri: vscode.Uri.file('/mock/storage/path'),
    secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        onDidChange: createMockEvent()
    },
    extension: {
        id: 'mock.extension',
        extensionUri: vscode.Uri.file('/mock/extension/path'),
        extensionPath: '/mock/extension/path',
        isActive: true,
        packageJSON: {},
        exports: undefined,
        activate: () => Promise.resolve(),
        extensionKind: vscode.ExtensionKind.Workspace
    },
    languageModelAccessInformation: {
        endpoint: 'http://localhost:11434',
        authHeader: 'Bearer mock-token',
        onDidChange: createMockEvent(),
        canSendRequest: true
    }
};
// Mock vscode.window
const mockWindow = {
    createOutputChannel: (name) => ({
        append: () => { },
        appendLine: () => { },
        clear: () => { },
        dispose: () => { },
        hide: () => { },
        show: () => { },
        name
    })
};
// Replace vscode.window with our mock
vscode.window = mockWindow;
async function testModelCoordinator() {
    // Initialize services
    const ollamaService = new ollamaService_1.OllamaService(mockContext);
    const modelCoordinator = new modelCoordinator_1.ModelCoordinator(ollamaService, mockContext);
    try {
        console.log('Starting ModelCoordinator capability tests...\n');
        // Test 1: General chat capability
        console.log('Test 1: Testing general chat capability...');
        const chatResult = await modelCoordinator.handleTask('Explain what a fibonacci sequence is in simple terms');
        console.log('Chat Result:', chatResult, '\n');
        // Test 2: Code generation capability
        console.log('Test 2: Testing code generation capability...');
        const codeResult = await modelCoordinator.handleTask('Write a TypeScript function that implements binary search');
        console.log('Code Generation Result:', codeResult, '\n');
        // Test 3: Code analysis capability
        console.log('Test 3: Testing code analysis capability...');
        const analysisResult = await modelCoordinator.handleTask('Analyze this code and suggest improvements:\n' +
            'function add(a,b) { return a + b; }');
        console.log('Code Analysis Result:', analysisResult, '\n');
        // Test 4: Model switching
        console.log('Test 4: Testing model switching...');
        const currentModel = modelCoordinator.getCurrentModel();
        console.log('Current Model:', currentModel);
        // Force a model switch by requesting code generation
        await modelCoordinator.handleTask('Write a function to calculate prime numbers');
        const newModel = modelCoordinator.getCurrentModel();
        console.log('Model after code task:', newModel, '\n');
        console.log('All tests completed successfully!');
    }
    catch (error) {
        console.error('Error during testing:', error);
    }
}
// Run the tests
testModelCoordinator().catch(console.error);
//# sourceMappingURL=test-capabilities.js.map