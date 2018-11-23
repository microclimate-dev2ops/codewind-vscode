import * as vscode from "vscode";

import * as MCUtil from "../../MCUtil";
import ITreeItemAdaptable from "../../view/TreeItemAdaptable";
import ProjectState from "./ProjectState";
import ProjectType from "./ProjectType";
import Connection from "../connection/Connection";
import * as Resources from "../../constants/Resources";
import Log from "../../Logger";
import Commands from "../../constants/Commands";
import DebugUtils from "./DebugUtils";
import Translator from "../../constants/strings/translator";
import StringNamespaces from "../../constants/strings/StringNamespaces";
import ProjectPendingState from "./ProjectPendingState";

const STRING_NS = StringNamespaces.PROJECT;

export default class Project implements ITreeItemAdaptable, vscode.QuickPickItem {

    // these below must match package.nls.json
    private static readonly CONTEXT_ID_BASE: string = "ext.mc.projectItem";                                 // non-nls
    private static readonly CONTEXT_ID_ENABLED:  string = Project.CONTEXT_ID_BASE + ".enabled";             // non-nls
    private static readonly CONTEXT_ID_DISABLED: string = Project.CONTEXT_ID_BASE + ".disabled";            // non-nls
    private static readonly CONTEXT_ID_DEBUGGABLE: string = Project.CONTEXT_ID_ENABLED + ".debugging";      // non-nls

    public readonly name: string;
    public readonly id: string;
    public readonly type: ProjectType;
    public readonly contextRoot: string;
    public readonly localPath: vscode.Uri;

    private _containerID: string | undefined;
    private _appPort: number | undefined;
    private _debugPort: number | undefined;
    private _autoBuildEnabled: boolean;

    public static readonly diagnostics: vscode.DiagnosticCollection
        = vscode.languages.createDiagnosticCollection("Microclimate");

    // Dates below will always be set, but might be "invalid date"s
    private _lastBuild: Date;
    private _lastImgBuild: Date;

    // QuickPickItem
    public readonly label: string;
    public readonly detail?: string;

    private _state: ProjectState;

    private pendingAppState: ProjectPendingState | undefined;

    constructor(
        projectInfo: any,
        public readonly connection: Connection,
    ) {
        Log.d("Creating project from info:", projectInfo);
        this.name = projectInfo.name;
        this.id = projectInfo.projectID;

        this._containerID = projectInfo.containerId;
        this._autoBuildEnabled = projectInfo.autoBuild;
        // lastbuild is a number
        this._lastBuild = new Date(projectInfo.lastbuild);
        // appImageLastBuild is a string
        this._lastImgBuild = new Date(Number(projectInfo.appImgLastBuild));

        // TODO should use projectType not buildType but it's missing sometimes
        this.type = new ProjectType(projectInfo.buildType, projectInfo.language);

        this.localPath = vscode.Uri.file(
            MCUtil.appendPathWithoutDupe(connection.workspacePath.fsPath, projectInfo.locOnDisk)
        );

        this.contextRoot = projectInfo.contextroot || "";       // non-nls

        this._state = this.update(projectInfo);

        // QuickPickItem
        this.label = Translator.t(STRING_NS, "quickPickLabel", { projectName: this.name, projectType: this.type.type });
        // this.detail = this.id;

        Log.d(`Created project ${this.name}:`, this);
    }

    public getChildren(): ITreeItemAdaptable[] {
        // Projects have no children.
        return [];
    }

    public toTreeItem(): vscode.TreeItem {
        const ti = new vscode.TreeItem(
            Translator.t(StringNamespaces.TREEVIEW, "projectLabel", { projectName: this.name, state: this.state.toString() }),
            vscode.TreeItemCollapsibleState.None
        );

        // ti.resourceUri = this.localPath;
        ti.tooltip = this.state.toString();
        // There are different context menu actions available to enabled or disabled or debugging projects
        ti.contextValue = this.getContextID();
        ti.iconPath = this.type.icon;
        // command run on single-click (or double click - depends on a user setting - https://github.com/Microsoft/vscode/issues/39601)
        // Focuses on this project in the explorer view. Has no effect if the project is not in the current workspace.
        ti.command = {
            command: Commands.VSC_REVEAL_EXPLORER,
            title: "",      // non-nls
            arguments: [this.localPath]
        };
        // Logger.log(`Created TreeItem`, ti);
        return ti;
    }

    private getContextID(): string {
        if (this._state.isEnabled) {
            if (ProjectState.getDebuggableStates().includes(this._state.appState)) {
                return Project.CONTEXT_ID_DEBUGGABLE;
            }
            else {
                return Project.CONTEXT_ID_ENABLED;
            }
        }
        else {
            return Project.CONTEXT_ID_DISABLED;
        }
    }

    // description used by QuickPickItem
    public get description(): string {
        const appUrl = this.appBaseUrl;
        if (appUrl != null) {
            return appUrl.toString();
        }
        else {
            return Translator.t(STRING_NS, "quickPickNotRunning");
        }
    }

    /**
     * Set this project's status based on the project info event payload passed.
     * This includes checking the appStatus, buildStatus, buildStatusDetail, and startMode.
     * Also updates the appPort and debugPort.
     *
     * Also signals the ConnectionManager change listener
     */
    public update = (projectInfo: any): ProjectState => {
        if (projectInfo.projectID !== this.id) {
            // shouldn't happen, but just in case
            Log.e(`Project ${this.id} received status update request for wrong project ${projectInfo.projectID}`);
            // return the old state
            return this._state;
        }

        this._containerID = projectInfo.containerId;
        this._lastBuild = new Date(projectInfo.lastbuild);
        this._lastImgBuild = new Date(Number(projectInfo.appImageLastBuild));

        if (projectInfo.autoBuild != null) {
            this._autoBuildEnabled = projectInfo.autoBuild;
        }

        // note oldState can be null if this is the first time update is being invoked.
        const oldState = this._state;
        this._state = new ProjectState(projectInfo, oldState != null ? oldState : undefined);

        // Whether or not this update call has changed the project such that we have to update the UI.
        let changed: boolean = false;
        if (this._state !== oldState) {
            changed = true;
            Log.d(`${this.name} went from ${oldState} to ${this._state} startMode=${projectInfo.startMode}`);
        }

        const newContainerID: string | undefined = projectInfo.containerID;
        if (newContainerID != null) {
            this._containerID = newContainerID;
            Log.i(`New containerID for ${this.name} is ${this._containerID.substring(0, 8)}`);
        }

        const ports = projectInfo.ports;
        if (ports != null) {
            changed = this.setAppPort(ports.exposedPort) || changed;
            changed = this.setDebugPort(ports.exposedDebugPort) || changed;
        }
        else if (this._state.isStarted) {
            Log.e("No ports were provided for an app that is supposed to be started");
        }

        // If we're waiting for a state, check if we've reached one the states, and resolve the pending state promise if so.
        if (this.pendingAppState != null && this.pendingAppState.shouldResolve(this.state)) {
            this.fullfillPendingState(true);
        }

        // Logger.log(`${this.name} has a new status:`, this._state);
        if (changed) {
            this.connection.onChange();
        }

        return this._state;
    }

    /**
     * Return a promise that resolves to the current appState when this project enters one of the given AppStates,
     * or rejects if waitForState is called again before the previous state is reached.
     * The state is checked when it changes in update() above.
     *
     * **DO NOT** call this from test code, since it will also clear any previous state being waited for,
     * changing how the product code executes.
     */
    public async waitForState(timeoutMs: number, ...states: ProjectState.AppStates[]): Promise<ProjectState.AppStates> {
        Log.i(`${this.name} is waiting up to ${timeoutMs}ms for states: ${states.join(", ")}`);

        if (states.length === 0) {
            // Should never happen
            Log.e("Empty states array passed to waitForState");
            return this._state.appState;
        }

        // If project is given a new state to wait for before we resolved the previous state, reject the old state.
        this.fullfillPendingState(false);

        if (states.includes(this._state.appState)) {
            Log.i("No need to wait, already in state " + this._state.appState);
            return this._state.appState;
        }

        Log.i(this.name + " is currently", this._state.appState);

        const pendingStatePromise = new Promise<ProjectState.AppStates>( (resolve, reject) => {
            const timeout = setTimeout(
                () => {
                    this.fullfillPendingState(false, timeoutMs);
                },
                timeoutMs);

            this.pendingAppState = new ProjectPendingState(this, states, resolve, reject, timeout);
        });

        // Set a status bar msg to tell the user a project is waiting for a state
        const syncIcon: string = Resources.getOcticon(Resources.Octicons.sync, true);

        // pendingAppState will never be null here because we just set it above.
        const statesStr = this.pendingAppState != null ? this.pendingAppState.pendingStatesAsStr() : "";
        const waitingMsg = Translator.t(STRING_NS, "waitingForState",
                { projectName: this.name, pendingStates: statesStr }
        );
        vscode.window.setStatusBarMessage(`${syncIcon} ${waitingMsg}`, pendingStatePromise);    // non-nls

        return pendingStatePromise;
    }

    /**
     * If there is a pending state, resolve or reject it depending on the value of `resolve`.
     * If there is no pending state, do nothing.
     */
    private fullfillPendingState(resolve: boolean, timeoutMs?: number): void {
        if (this.pendingAppState != null) {
            Log.d(`${this.name} fulfillPendingState: ${resolve ? "resolving" : "rejecting"}`);
            if (resolve) {
                this.pendingAppState.resolve();
            }
            else {
                this.pendingAppState.reject(timeoutMs);
            }
            this.pendingAppState = undefined;
        }
        else {
            Log.d("No pending state to resolve/reject");
        }
    }

    /**
     * Callback for when this project is deleted in Microclimate
     */
    public async onDelete(): Promise<void> {
        vscode.window.showInformationMessage(Translator.t(STRING_NS, "onDeletion", { projectName: this.name }));
        this.fullfillPendingState(true);
        this.clearValidationErrors();
        this.connection.logManager.destroyLogsForProject(this.id);
        DebugUtils.removeDebugLaunchConfigFor(this);
    }

    public async clearValidationErrors(): Promise<void> {
        // Clear all diagnostics for this project's path
        Project.diagnostics.delete(this.localPath);
    }

    public setAutoBuild(newAutoBuild: boolean): void {
        if (newAutoBuild != null) {
            this._autoBuildEnabled = newAutoBuild;
            Log.i(`Auto build status changed for ${this.name} to ${this._autoBuildEnabled}`);
        }
    }

    public get containerID(): string | undefined {
        return this._containerID;
    }

    public get appPort(): number | undefined {
        return this._appPort;
    }

    public get debugPort(): number | undefined {
        return this._debugPort;
    }

    public get autoBuildEnabled(): boolean {
        return this._autoBuildEnabled;
    }

    public get state(): ProjectState {
        return this._state;
    }

    public get appBaseUrl(): vscode.Uri | undefined {
        if (this._appPort == null) {
            // app is stopped, disabled, etc.
            return undefined;
        }

        return this.connection.mcUri.with({
            authority: `${this.connection.host}:${this._appPort}`,      // non-nls
            path: this.contextRoot
        });
    }

    public get debugUrl(): string | undefined {
        if (this._debugPort == null) {
            return undefined;
        }

        return this.connection.host + ":" + this._debugPort;            // non-nls
    }

    public get lastBuild(): Date {
        return this._lastBuild;
    }

    public get lastImgBuild(): Date {
        return this._lastImgBuild;
    }

    /**
     *
     * @return If this project's app port was changed.
     */
    private setAppPort(newAppPort: number | undefined): boolean {
        newAppPort = Number(newAppPort);

        if (isNaN(newAppPort)) {
            // Should happen when the app stops.
            if (this._appPort != null) {
                Log.d("Unset app port for " + this.name);
                this._appPort = undefined;
                return true;
            }
        }
        else if (!MCUtil.isGoodPort(newAppPort)) {
            Log.w(`Invalid app port ${newAppPort} given to project ${this.name}, ignoring it`);
            return false;
        }
        else if (this._appPort !== newAppPort) {
            this._appPort = newAppPort;
            Log.d(`New app port for ${this.name} is ${newAppPort}`);
            return true;
        }
        return false;
    }

    /**
     *
     * @return If this project's debug port was changed.
     */
    private setDebugPort(newDebugPort: number | undefined): boolean {
        newDebugPort = Number(newDebugPort);

        if (isNaN(newDebugPort)) {
            // Should happen when the app stops or exits debug mode
            if (this._debugPort != null) {
                Log.d("Unset debug port for " + this.name);
                this._debugPort = undefined;
                return true;
            }
        }
        else if (!MCUtil.isGoodPort(newDebugPort)) {
            Log.w(`Invalid debug port ${newDebugPort} given to project ${this.name}, ignoring it`);
            return false;
        }
        else if (this._debugPort !== newDebugPort) {
            this._debugPort = newDebugPort;
            Log.d(`New debug port for ${this.name} is ${newDebugPort}`);
            return true;
        }
        return false;
    }
}
