// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import { inject, injectable, multiInject, named } from 'inversify';
import * as path from 'path';
import {
    CancellationToken,
    CancellationTokenSource,
    Event,
    EventEmitter,
    Memento,
    Uri,
    ViewColumn,
    WebviewPanel
} from 'vscode';

import * as uuid from 'uuid/v4';
import { createErrorOutput } from '../../../datascience-ui/common/cellFactory';
import {
    IApplicationShell,
    ICommandManager,
    IDocumentManager,
    ILiveShareApi,
    IWebPanelProvider,
    IWorkspaceService
} from '../../common/application/types';
import { ContextKey } from '../../common/contextKey';
import { traceError, traceInfo } from '../../common/logger';
import { IFileSystem, TemporaryFile } from '../../common/platform/types';
import {
    GLOBAL_MEMENTO,
    IAsyncDisposableRegistry,
    IConfigurationService,
    IDisposableRegistry,
    IExperimentsManager,
    IMemento,
    Resource,
    WORKSPACE_MEMENTO
} from '../../common/types';
import { createDeferred, Deferred } from '../../common/utils/async';
import * as localize from '../../common/utils/localize';
import { StopWatch } from '../../common/utils/stopWatch';
import { EXTENSION_ROOT_DIR } from '../../constants';
import { PythonInterpreter } from '../../pythonEnvironments/discovery/types';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { EditorContexts, Identifiers, Telemetry } from '../constants';
import { InteractiveBase } from '../interactive-common/interactiveBase';
import {
    INativeCommand,
    INotebookIdentity,
    InteractiveWindowMessages,
    IReExecuteCells,
    IRunByLine,
    ISubmitNewCell,
    NotebookModelChange,
    SysInfoReason,
    VariableExplorerStateKeys
} from '../interactive-common/interactiveWindowTypes';
import {
    CellState,
    ICell,
    ICodeCssGenerator,
    IDataScienceErrorHandler,
    IInteractiveWindowInfo,
    IInteractiveWindowListener,
    IJupyterDebugger,
    IJupyterExecution,
    IJupyterKernelSpec,
    IJupyterVariableDataProviderFactory,
    IJupyterVariables,
    INotebookEditor,
    INotebookEditorProvider,
    INotebookExporter,
    INotebookImporter,
    INotebookModel,
    INotebookProvider,
    IStatusProvider,
    IThemeFinder,
    WebViewViewChangeEventArgs
} from '../types';
import { NativeEditorSynchronizer } from './nativeEditorSynchronizer';

import type { nbformat } from '@jupyterlab/coreutils';
// tslint:disable-next-line: no-require-imports
import cloneDeep = require('lodash/cloneDeep');
import { concatMultilineStringInput, splitMultilineString } from '../../../datascience-ui/common';
import { ServerStatus } from '../../../datascience-ui/interactive-common/mainState';
import { isTestExecution, PYTHON_LANGUAGE, UseCustomEditorApi } from '../../common/constants';
import { translateKernelLanguageToMonaco } from '../common';
import { IDataViewerFactory } from '../data-viewing/types';
import { getCellHashProvider } from '../editor-integration/cellhashprovider';
import { KernelSwitcher } from '../jupyter/kernels/kernelSwitcher';

const nativeEditorDir = path.join(EXTENSION_ROOT_DIR, 'out', 'datascience-ui', 'notebook');
@injectable()
export class NativeEditor extends InteractiveBase implements INotebookEditor {
    public get onDidChangeViewState(): Event<void> {
        return this._onDidChangeViewState.event;
    }

    public get visible(): boolean {
        return this.viewState.visible;
    }

    public get active(): boolean {
        return this.viewState.active;
    }

    public get file(): Uri {
        if (this.model) {
            return this.model.file;
        }
        return Uri.file('');
    }

    public get isUntitled(): boolean {
        return this.model ? this.model.isUntitled : false;
    }

    public get closed(): Event<INotebookEditor> {
        return this.closedEvent.event;
    }

    public get executed(): Event<INotebookEditor> {
        return this.executedEvent.event;
    }

    public get modified(): Event<INotebookEditor> {
        return this.modifiedEvent.event;
    }
    public get saved(): Event<INotebookEditor> {
        return this.savedEvent.event;
    }

    public get isDirty(): boolean {
        return this.model ? this.model.isDirty : false;
    }
    public model: Readonly<INotebookModel> | undefined;
    protected savedEvent: EventEmitter<INotebookEditor> = new EventEmitter<INotebookEditor>();
    protected closedEvent: EventEmitter<INotebookEditor> = new EventEmitter<INotebookEditor>();
    protected modifiedEvent: EventEmitter<INotebookEditor> = new EventEmitter<INotebookEditor>();

    private sentExecuteCellTelemetry: boolean = false;
    private _onDidChangeViewState = new EventEmitter<void>();
    private executedEvent: EventEmitter<INotebookEditor> = new EventEmitter<INotebookEditor>();
    private loadedPromise: Deferred<void> = createDeferred<void>();
    private startupTimer: StopWatch = new StopWatch();
    private loadedAllCells: boolean = false;
    private executeCancelTokens = new Set<CancellationTokenSource>();

    constructor(
        @multiInject(IInteractiveWindowListener) listeners: IInteractiveWindowListener[],
        @inject(ILiveShareApi) liveShare: ILiveShareApi,
        @inject(IApplicationShell) applicationShell: IApplicationShell,
        @inject(IDocumentManager) documentManager: IDocumentManager,
        @inject(IWebPanelProvider) provider: IWebPanelProvider,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(ICodeCssGenerator) cssGenerator: ICodeCssGenerator,
        @inject(IThemeFinder) themeFinder: IThemeFinder,
        @inject(IStatusProvider) statusProvider: IStatusProvider,
        @inject(IJupyterExecution) jupyterExecution: IJupyterExecution,
        @inject(IFileSystem) fileSystem: IFileSystem,
        @inject(IConfigurationService) configuration: IConfigurationService,
        @inject(ICommandManager) commandManager: ICommandManager,
        @inject(INotebookExporter) jupyterExporter: INotebookExporter,
        @inject(IWorkspaceService) workspaceService: IWorkspaceService,
        @inject(NativeEditorSynchronizer) private readonly synchronizer: NativeEditorSynchronizer,
        @inject(INotebookEditorProvider) private editorProvider: INotebookEditorProvider,
        @inject(IDataViewerFactory) dataExplorerFactory: IDataViewerFactory,
        @inject(IJupyterVariableDataProviderFactory)
        jupyterVariableDataProviderFactory: IJupyterVariableDataProviderFactory,
        @inject(IJupyterVariables) @named(Identifiers.ALL_VARIABLES) jupyterVariables: IJupyterVariables,
        @inject(IJupyterDebugger) jupyterDebugger: IJupyterDebugger,
        @inject(INotebookImporter) protected readonly importer: INotebookImporter,
        @inject(IDataScienceErrorHandler) errorHandler: IDataScienceErrorHandler,
        @inject(IMemento) @named(GLOBAL_MEMENTO) globalStorage: Memento,
        @inject(IMemento) @named(WORKSPACE_MEMENTO) workspaceStorage: Memento,
        @inject(IExperimentsManager) experimentsManager: IExperimentsManager,
        @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry,
        @inject(KernelSwitcher) switcher: KernelSwitcher,
        @inject(INotebookProvider) notebookProvider: INotebookProvider,
        @inject(UseCustomEditorApi) useCustomEditorApi: boolean
    ) {
        super(
            listeners,
            liveShare,
            applicationShell,
            documentManager,
            provider,
            disposables,
            cssGenerator,
            themeFinder,
            statusProvider,
            jupyterExecution,
            fileSystem,
            configuration,
            jupyterExporter,
            workspaceService,
            dataExplorerFactory,
            jupyterVariableDataProviderFactory,
            jupyterVariables,
            jupyterDebugger,
            errorHandler,
            commandManager,
            globalStorage,
            workspaceStorage,
            nativeEditorDir,
            [
                path.join(nativeEditorDir, 'require.js'),
                path.join(nativeEditorDir, 'ipywidgets.js'),
                path.join(nativeEditorDir, 'monaco.bundle.js'),
                path.join(nativeEditorDir, 'commons.initial.bundle.js'),
                path.join(nativeEditorDir, 'nativeEditor.js')
            ],
            localize.DataScience.nativeEditorTitle(),
            ViewColumn.Active,
            experimentsManager,
            switcher,
            notebookProvider,
            useCustomEditorApi
        );
        asyncRegistry.push(this);

        this.synchronizer.subscribeToUserActions(this, this.postMessage.bind(this));
    }

    public dispose(): Promise<void> {
        super.dispose();
        this.model?.dispose(); // NOSONAR
        return this.close();
    }

    public async load(model: INotebookModel, webViewPanel: WebviewPanel): Promise<void> {
        // Save the model we're using
        this.model = model;

        // Indicate we have our identity
        this.loadedPromise.resolve();

        traceInfo(`Loading web panel for ${model.file}`);

        // Load the web panel using our file path so it can find
        // relative files next to the notebook.
        await super.loadWebPanel(path.dirname(this.file.fsPath), webViewPanel);

        // Sign up for dirty events
        model.changed(this.modelChanged.bind(this));
    }

    // tslint:disable-next-line: no-any
    public onMessage(message: string, payload: any) {
        super.onMessage(message, payload);
        switch (message) {
            case InteractiveWindowMessages.Started:
                if (this.model) {
                    // Load our cells, but don't wait for this to finish, otherwise the window won't load.
                    this.sendInitialCellsToWebView(this.model.cells)
                        .then(() => {
                            // May alread be dirty, if so send a message
                            if (this.model?.isDirty) {
                                this.postMessage(InteractiveWindowMessages.NotebookDirty).ignoreErrors();
                            }
                        })
                        .catch((exc) => traceError('Error loading cells: ', exc));
                }
                break;
            case InteractiveWindowMessages.Sync:
                this.synchronizer.notifyUserAction(payload, this);
                break;

            case InteractiveWindowMessages.ReExecuteCells:
                this.executedEvent.fire(this);
                break;

            case InteractiveWindowMessages.SaveAll:
                this.handleMessage(message, payload, this.saveAll);
                break;

            case InteractiveWindowMessages.Export:
                this.handleMessage(message, payload, this.export);
                break;

            case InteractiveWindowMessages.UpdateModel:
                this.handleMessage(message, payload, this.updateModel);
                break;

            case InteractiveWindowMessages.NativeCommand:
                this.handleMessage(message, payload, this.logNativeCommand);
                break;

            // call this to update the whole document for intellisense
            case InteractiveWindowMessages.LoadAllCellsComplete:
                this.handleMessage(message, payload, this.loadCellsComplete);
                break;

            case InteractiveWindowMessages.RestartKernel:
                this.interruptExecution();
                break;

            case InteractiveWindowMessages.Interrupt:
                this.interruptExecution();
                break;

            case InteractiveWindowMessages.RunByLine:
                this.handleMessage(message, payload, this.handleRunByLine);
                break;

            default:
                break;
        }
    }

    public async getNotebookMetadata(): Promise<nbformat.INotebookMetadata | undefined> {
        await this.loadedPromise.promise;
        if (this.model) {
            return this.model.metadata;
        }
    }

    public async updateNotebookOptions(
        kernelSpec: IJupyterKernelSpec,
        interpreter: PythonInterpreter | undefined
    ): Promise<void> {
        if (this.model) {
            const change: NotebookModelChange = {
                kind: 'version',
                kernelSpec,
                interpreter,
                oldDirty: this.model.isDirty,
                newDirty: true,
                source: 'user'
            };
            this.updateModel(change);
        }
    }

    public runAllCells() {
        this.postMessage(InteractiveWindowMessages.NotebookRunAllCells).ignoreErrors();
    }

    public runSelectedCell() {
        this.postMessage(InteractiveWindowMessages.NotebookRunSelectedCell).ignoreErrors();
    }

    public addCellBelow() {
        this.postMessage(InteractiveWindowMessages.NotebookAddCellBelow, { newCellId: uuid() }).ignoreErrors();
    }

    public async getOwningResource(): Promise<Resource> {
        // Resource to use for loading and our identity are the same.
        const identity = await this.getNotebookIdentity();
        return identity.resource;
    }

    protected addSysInfo(reason: SysInfoReason): Promise<void> {
        // We need to send a message when restarting
        if (reason === SysInfoReason.Restart || reason === SysInfoReason.New) {
            this.postMessage(InteractiveWindowMessages.RestartKernel).ignoreErrors();
        }

        // These are not supported.
        return Promise.resolve();
    }

    protected submitCode(
        code: string,
        file: string,
        line: number,
        id?: string,
        data?: nbformat.ICodeCell | nbformat.IRawCell | nbformat.IMarkdownCell,
        debugOptions?: { runByLine: boolean; hashFileName?: string },
        cancelToken?: CancellationToken
    ): Promise<boolean> {
        const stopWatch = new StopWatch();
        return super
            .submitCode(code, file, line, id, data, debugOptions, cancelToken)
            .finally(() => this.sendPerceivedCellExecute(stopWatch));
    }

    @captureTelemetry(Telemetry.SubmitCellThroughInput, undefined, false)
    // tslint:disable-next-line:no-any
    protected submitNewCell(info: ISubmitNewCell) {
        // If there's any payload, it has the code and the id
        if (info && info.code && info.id) {
            try {
                // Activate the other side, and send as if came from a file
                this.editorProvider
                    .show(this.file)
                    .then((_v) => {
                        this.shareMessage(InteractiveWindowMessages.RemoteAddCode, {
                            code: info.code,
                            file: Identifiers.EmptyFileName,
                            line: 0,
                            id: info.id,
                            originator: this.id,
                            debug: false
                        });
                    })
                    .ignoreErrors();
                // Send to ourselves.
                this.submitCode(info.code, Identifiers.EmptyFileName, 0, info.id).ignoreErrors();
            } catch (exc) {
                this.errorHandler.handleError(exc).ignoreErrors();
            }
        }
    }

    @captureTelemetry(Telemetry.ExecuteNativeCell, undefined, true)
    // tslint:disable-next-line:no-any
    protected async reexecuteCells(info: IReExecuteCells): Promise<void> {
        // This is here for existing functional tests that somehow pass undefined into this method.
        if (!this.model || !info || !Array.isArray(info.cellIds)) {
            return;
        }
        const tokenSource = new CancellationTokenSource();
        this.executeCancelTokens.add(tokenSource);
        const cellsExecuting = new Set<ICell>();
        try {
            for (let i = 0; i < info.cellIds.length && !tokenSource.token.isCancellationRequested; i += 1) {
                const cell = this.model.cells.find((item) => item.id === info.cellIds[i]);
                if (!cell) {
                    continue;
                }
                cellsExecuting.add(cell);
                await this.reexecuteCell(cell, tokenSource.token);
                cellsExecuting.delete(cell);
            }
        } catch (exc) {
            // Tell the other side we restarted the kernel. This will stop all executions
            this.postMessage(InteractiveWindowMessages.RestartKernel).ignoreErrors();

            // Handle an error
            await this.errorHandler.handleError(exc);
        } finally {
            this.executeCancelTokens.delete(tokenSource);

            // Make sure everything is marked as finished or error after the final finished
            cellsExecuting.forEach((cell) => this.finishCell(cell));
        }
    }

    protected async getNotebookIdentity(): Promise<INotebookIdentity> {
        if (this.loadedPromise) {
            await this.loadedPromise.promise;
        }

        // File should be set now
        return {
            resource: this.file,
            type: 'native'
        };
    }

    protected async setLaunchingFile(_file: string): Promise<void> {
        // For the native editor, use our own file as the path
        const notebook = this.getNotebook();
        if (this.fileSystem.fileExists(this.file.fsPath) && notebook) {
            await notebook.setLaunchingFile(this.file.fsPath);
        }
    }

    protected sendCellsToWebView(cells: ICell[]) {
        // Filter out sysinfo messages. Don't want to show those
        const filtered = cells.filter((c) => c.data.cell_type !== 'messages');

        // Update these cells in our storage only when cells are finished
        const modified = filtered.filter((c) => c.state === CellState.finished || c.state === CellState.error);
        const unmodified = this.model?.cells.filter((c) => modified.find((m) => m.id === c.id));
        if (modified.length > 0 && unmodified && this.model) {
            // As this point, we're updating the model because of changes to the cell as a result of execution.
            // The output and execution count change, however we're just going to update everything.
            // But, we should not update the `source`. The only time source can change is when a request comes from the UI.
            // Perhaps we need a finer grained update (update only output and execution count along with `source=execution`).
            // For now retain source from previous model.
            // E.g. user executes a cell, in the mean time they update the text. Now model contains new value.
            // However once execution has completed, this code will update the model with results from previous execution (prior to edit).
            // We now need to give preference to the text in the model, over the old one that was executed.
            modified.forEach((modifiedCell) => {
                const originalCell = unmodified.find((unmodifiedCell) => unmodifiedCell.id === modifiedCell.id);
                if (originalCell) {
                    modifiedCell.data.source = originalCell.data.source;
                }
            });
            this.model.update({
                source: 'user',
                kind: 'modify',
                newCells: modified,
                oldCells: cloneDeep(unmodified),
                oldDirty: this.model.isDirty,
                newDirty: true
            });
        }

        // Tell storage about our notebook object
        const notebook = this.getNotebook();
        if (notebook && this.model) {
            const interpreter = notebook.getMatchingInterpreter();
            const kernelSpec = notebook.getKernelSpec();
            this.model.update({
                source: 'user',
                kind: 'version',
                oldDirty: this.model.isDirty,
                newDirty: this.model.isDirty,
                interpreter,
                kernelSpec
            });
        }

        // Send onto the webview.
        super.sendCellsToWebView(filtered);
    }

    protected updateContexts(info: IInteractiveWindowInfo | undefined) {
        // This should be called by the python interactive window every
        // time state changes. We use this opportunity to update our
        // extension contexts
        if (this.commandManager && this.commandManager.executeCommand) {
            const nativeContext = new ContextKey(EditorContexts.HaveNative, this.commandManager);
            nativeContext.set(!this.isDisposed).catch();
            const interactiveCellsContext = new ContextKey(EditorContexts.HaveNativeCells, this.commandManager);
            const redoableContext = new ContextKey(EditorContexts.HaveNativeRedoableCells, this.commandManager);
            const hasCellSelectedContext = new ContextKey(EditorContexts.HaveCellSelected, this.commandManager);
            if (info) {
                interactiveCellsContext.set(info.cellCount > 0).catch();
                redoableContext.set(info.redoCount > 0).catch();
                hasCellSelectedContext.set(info.selectedCell ? true : false).catch();
            } else {
                hasCellSelectedContext.set(false).catch();
                interactiveCellsContext.set(false).catch();
                redoableContext.set(false).catch();
            }
        }
    }

    protected async onViewStateChanged(args: WebViewViewChangeEventArgs) {
        super.onViewStateChanged(args);

        // Update our contexts
        const nativeContext = new ContextKey(EditorContexts.HaveNative, this.commandManager);
        nativeContext.set(args.current.visible && args.current.active).catch();
        this._onDidChangeViewState.fire();
    }

    protected async closeBecauseOfFailure(_exc: Error): Promise<void> {
        // Actually don't close, just let the error bubble out
    }

    protected async close(): Promise<void> {
        // Fire our event
        this.closedEvent.fire(this);
    }

    protected saveAll() {
        // Ask user for a save as dialog if no title
        if (this.isUntitled) {
            this.commandManager.executeCommand('workbench.action.files.saveAs', this.file);
        } else {
            this.commandManager.executeCommand('workbench.action.files.save', this.file);
        }
    }

    private async modelChanged(change: NotebookModelChange) {
        if (change.source !== 'user') {
            // VS code is telling us to broadcast this to our UI. Tell the UI about the new change. Remove the
            // the model so this doesn't have to be stringified
            await this.postMessage(InteractiveWindowMessages.UpdateModel, { ...change, model: undefined });
        }
        if (change.kind === 'saveAs' && change.model) {
            const newFileName = change.model.file.toString();
            const oldFileName = change.sourceUri.toString();

            if (newFileName !== oldFileName) {
                // If the filename has changed
                this.renameVariableExplorerHeights(oldFileName, newFileName);
            }
        }

        // Use the current state of the model to indicate dirty (not the message itself)
        if (this.model && change.newDirty !== change.oldDirty) {
            this.modifiedEvent.fire(this);
            if (this.model.isDirty) {
                await this.postMessage(InteractiveWindowMessages.NotebookDirty);
            } else {
                // Then tell the UI
                await this.postMessage(InteractiveWindowMessages.NotebookClean);
            }
        }
    }

    private renameVariableExplorerHeights(name: string, updatedName: string) {
        // Updates the workspace storage to reflect the updated name of the notebook
        // should be called if the name of the notebook changes
        // tslint:disable-next-line: no-any
        const value = this.workspaceStorage.get(VariableExplorerStateKeys.height, {} as any);
        if (!(name in value)) {
            return; // Nothing to update
        }

        value[updatedName] = value[name];
        delete value[name];
        this.workspaceStorage.update(VariableExplorerStateKeys.height, value);
    }

    private interruptExecution() {
        this.executeCancelTokens.forEach((t) => t.cancel());
    }

    private finishCell(cell: ICell) {
        this.sendCellsToWebView([
            {
                ...cell,
                state: CellState.finished
            }
        ]);
    }

    private async reexecuteCell(cell: ICell, cancelToken: CancellationToken): Promise<void> {
        try {
            // If there's any payload, it has the code and the id
            if (cell.id && cell.data.cell_type !== 'messages') {
                traceInfo(`Executing cell ${cell.id}`);

                // Clear the result if we've run before
                await this.clearResult(cell.id);

                // Clear 'per run' data passed to WebView before execution
                if (cell.data.metadata.tags !== undefined) {
                    cell.data.metadata.tags = cell.data.metadata.tags.filter((t) => t !== 'outputPrepend');
                }

                const code = concatMultilineStringInput(cell.data.source);
                // Send to ourselves.
                await this.submitCode(code, Identifiers.EmptyFileName, 0, cell.id, cell.data, undefined, cancelToken);
            }
        } catch (exc) {
            traceInfo(`Exception executing cell ${cell.id}: `, exc);

            // Make this error our cell output
            this.sendCellsToWebView([
                {
                    // tslint:disable-next-line: no-any
                    data: { ...cell.data, outputs: [createErrorOutput(exc)] } as any, // nyc compiler issue
                    id: cell.id,
                    file: Identifiers.EmptyFileName,
                    line: 0,
                    state: CellState.error
                }
            ]);

            throw exc;
        } finally {
            if (cell && cell.id) {
                traceInfo(`Finished executing cell ${cell.id}`);
            }
        }
    }

    private sendPerceivedCellExecute(runningStopWatch?: StopWatch) {
        if (runningStopWatch) {
            const props = { notebook: true };
            if (!this.sentExecuteCellTelemetry) {
                this.sentExecuteCellTelemetry = true;
                sendTelemetryEvent(Telemetry.ExecuteCellPerceivedCold, runningStopWatch.elapsedTime, props);
            } else {
                sendTelemetryEvent(Telemetry.ExecuteCellPerceivedWarm, runningStopWatch.elapsedTime, props);
            }
        }
    }

    private updateModel(change: NotebookModelChange) {
        // Send to our model using a command. User has done something that changes the model
        if (change.source === 'user' && this.model) {
            // Note, originally this was posted with a command but sometimes had problems
            // with commands being handled out of order.
            this.model.update(change);
        }
    }

    private async sendInitialCellsToWebView(cells: ICell[]): Promise<void> {
        sendTelemetryEvent(Telemetry.CellCount, undefined, { count: cells.length });
        return this.postMessage(InteractiveWindowMessages.LoadAllCells, { cells });
    }

    @captureTelemetry(Telemetry.ConvertToPythonFile, undefined, false)
    private async export(): Promise<void> {
        const status = this.setStatus(localize.DataScience.convertingToPythonFile(), false);
        // First generate a temporary notebook with these cells.
        let tempFile: TemporaryFile | undefined;
        try {
            tempFile = await this.fileSystem.createTemporaryFile('.ipynb');

            // Translate the cells into a notebook
            const content = this.model ? this.model.getContent() : '';
            await this.fileSystem.writeFile(tempFile.filePath, content, 'utf-8');

            // Import this file and show it
            const contents = await this.importer.importFromFile(tempFile.filePath, this.file.fsPath);
            if (contents) {
                await this.viewDocument(contents);
            }
        } catch (e) {
            await this.errorHandler.handleError(e);
        } finally {
            if (tempFile) {
                tempFile.dispose();
            }
            status.dispose();
        }
    }

    private async viewDocument(contents: string): Promise<void> {
        const doc = await this.documentManager.openTextDocument({ language: 'python', content: contents });
        await this.documentManager.showTextDocument(doc, ViewColumn.One);
    }

    private logNativeCommand(args: INativeCommand) {
        sendTelemetryEvent(args.command);
    }

    private async loadCellsComplete() {
        if (!this.loadedAllCells) {
            this.loadedAllCells = true;
            sendTelemetryEvent(Telemetry.NotebookOpenTime, this.startupTimer.elapsedTime);
        }

        // If we don't have a server right now, at least show our kernel name (this seems to slow down tests
        // too much though)
        if (!isTestExecution()) {
            const metadata = await this.getNotebookMetadata();
            if (!this.notebook && metadata?.kernelspec) {
                this.postMessage(InteractiveWindowMessages.UpdateKernel, {
                    jupyterServerStatus: ServerStatus.NotStarted,
                    localizedUri: '',
                    displayName: metadata.kernelspec.display_name ?? metadata.kernelspec.name,
                    language: translateKernelLanguageToMonaco(
                        (metadata.kernelspec.language as string) ?? PYTHON_LANGUAGE
                    )
                }).ignoreErrors();
            }
        }
    }

    private async handleRunByLine(runByLine: IRunByLine) {
        try {
            // If there's any payload, it has the code and the id
            if (runByLine.cell.id && runByLine.cell.data.cell_type === 'code') {
                traceInfo(`Running by line cell ${runByLine.cell.id}`);

                // Clear the result if we've run before
                await this.clearResult(runByLine.cell.id);

                // Generate a hash file name for this cell.
                const notebook = this.getNotebook();
                if (notebook) {
                    const hashProvider = getCellHashProvider(notebook);
                    if (hashProvider) {
                        // Add the breakpoint to the first line of the cell so we actually stop
                        // on the first line.
                        const newSource = splitMultilineString(runByLine.cell.data.source);
                        newSource.splice(0, -1, 'breakpoint()\n');
                        runByLine.cell.data.source = newSource;

                        const hashFileName = hashProvider.generateHashFileName(
                            runByLine.cell,
                            runByLine.expectedExecutionCount
                        );
                        const code = concatMultilineStringInput(runByLine.cell.data.source);
                        // Send to ourselves.
                        await this.submitCode(
                            code,
                            Identifiers.EmptyFileName,
                            0,
                            runByLine.cell.id,
                            runByLine.cell.data,
                            {
                                runByLine: true,
                                hashFileName
                            }
                        );
                    }
                }
            } else {
                throw new Error('Run by line started with an invalid cell');
            }
        } catch (exc) {
            // Make this error our cell output
            this.sendCellsToWebView([
                {
                    // tslint:disable-next-line: no-any
                    data: { ...runByLine.cell.data, outputs: [createErrorOutput(exc)] } as any, // nyc compiler issue
                    id: runByLine.cell.id,
                    file: Identifiers.EmptyFileName,
                    line: 0,
                    state: CellState.error
                }
            ]);

            throw exc;
        } finally {
            if (runByLine.cell && runByLine.cell.id) {
                traceInfo(`Finished run by line on cell ${runByLine.cell.id}`);
            }
        }
    }
}
