/*
 * Copyright (c) 2018-2020 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { V1alpha2DevWorkspace, V1alpha2DevWorkspaceTemplate } from '@devfile/api';
import { DevfileCheTheiaPluginsResolver } from '@tmpwip/dw-handler/lib/devfile/devfile-che-theia-plugins-resolver';
import { InversifyBinding } from '@tmpwip/dw-handler/lib/inversify/inversify-bindings';

import { inject, injectable } from 'inversify';
import { convertDevWorkspaceV2ToV1, isDeleting, isWebTerminal } from '../helpers/devworkspace';
import { WorkspaceClient } from './';
import { DevWorkspaceClient as DevWorkspaceClientLibrary, IDevWorkspaceApi, IDevWorkspaceDevfile, IDevWorkspace, IDevWorkspaceTemplateApi, IDevWorkspaceTemplate, devWorkspaceApiGroup, devworkspaceSingularSubresource, devworkspaceVersion } from '@eclipse-che/devworkspace-client';
import { DevWorkspaceStatus, WorkspaceStatus } from '../helpers/types';
import { KeycloakSetupService } from '../keycloak/setup';
import { delay } from '../helpers/delay';
import { RestApi } from '@eclipse-che/devworkspace-client/dist/browser';

export interface IStatusUpdate {
  error?: string;
  status?: string;
  prevStatus?: string;
  workspaceId: string;
}

/**
 * This class manages the connection between the frontend and the devworkspace typescript library
 */
@injectable()
export class DevWorkspaceClient extends WorkspaceClient {

  private workspaceApi: IDevWorkspaceApi;
  private dwtApi: IDevWorkspaceTemplateApi;
  private previousItems: Map<string, Map<string, IStatusUpdate>>;
  private client: RestApi;
  private maxStatusAttempts: number;
  private initializing: Promise<void>;

  constructor(@inject(KeycloakSetupService) keycloakSetupService: KeycloakSetupService) {
    super(keycloakSetupService);
    this.axios.defaults.baseURL = '/api/unsupported/k8s';
    this.client = DevWorkspaceClientLibrary.getRestApi(this.axios);
    this.workspaceApi = this.client.workspaceApi;
    this.dwtApi = this.client.templateApi;
    this.previousItems = new Map();
    this.maxStatusAttempts = 10;
  }

  isEnabled(): Promise<boolean> {
    return this.client.isDevWorkspaceApiEnabled();
  }

  async getAllWorkspaces(defaultNamespace: string): Promise<che.Workspace[]> {
    await this.initializing;
    const workspaces = await this.workspaceApi.listInNamespace(defaultNamespace);
    const availableWorkspaces: che.Workspace[] = [];
    for (const workspace of workspaces) {
      if (!isDeleting(workspace) && !isWebTerminal(workspace)) {
        availableWorkspaces.push(convertDevWorkspaceV2ToV1(workspace));
      }
    }
    return availableWorkspaces;
  }

  async getWorkspaceByName(namespace: string, workspaceName: string): Promise<che.Workspace> {
    let workspace = await this.workspaceApi.getByName(namespace, workspaceName);
    let attempted = 0;
    while ((!workspace.status || !workspace.status.phase || !workspace.status.ideUrl) && attempted < this.maxStatusAttempts) {
      workspace = await this.workspaceApi.getByName(namespace, workspaceName);
      this.checkForDevWorkspaceError(workspace);
      attempted += 1;
      await delay();
    }
    this.checkForDevWorkspaceError(workspace);
    if (!workspace.status || !workspace.status.phase || !workspace.status.ideUrl) {
      throw new Error(`Could not retrieve devworkspace status information from ${workspaceName} in namespace ${namespace}`);
    }
    return convertDevWorkspaceV2ToV1(workspace);
  }

  async create(devfile: IDevWorkspaceDevfile, pluginsDevfile: IDevWorkspaceDevfile[], pluginRegistryUrl: string, attributes: { [key: string]: string } = {}): Promise<che.Workspace> {
    if (!devfile.components) {
      devfile.components = [];
    }

    console.log('attributes are', attributes);
    const search = attributes['SEARCH'];
    const searchParam = new window.URLSearchParams(search);
    let enableTheiaLibrary = false;
    searchParam.forEach((val: string, key: string) => {
      console.log('val ', val, 'is for key', key);
      if ('enableTheiaLibrary' === key && val === 'true') {
        enableTheiaLibrary = true;
      }
    });

    const createdWorkspace: V1alpha2DevWorkspace = await this.workspaceApi.create(devfile, false);
    const namespace = createdWorkspace?.metadata?.['namespace'];

    const devWorkspaceTemplates: V1alpha2DevWorkspaceTemplate[] = [];
    for (const pluginDevfile of pluginsDevfile) {
      // todo handle error in a proper way
      const pluginName = pluginDevfile.metadata.name.replaceAll(' ', '-').toLowerCase();
      const workspaceId = createdWorkspace?.status?.workspaceId;
      const devfileGroupVersion = `${devWorkspaceApiGroup}/${devworkspaceVersion}`;
      const template = <IDevWorkspaceTemplate>{
        kind: 'DevWorkspaceTemplate',
        apiVersion: devfileGroupVersion,
        metadata: {
          name: `${pluginName}-${workspaceId}`,
          namespace,
          ownerReferences: [
            {
              apiVersion: devfileGroupVersion,
              kind: devworkspaceSingularSubresource,
              name: createdWorkspace?.metadata?.['name'],
              uid: createdWorkspace?.metadata?.['uid']
            }
          ]
        },
        spec: pluginDevfile
      };
      devWorkspaceTemplates.push(template);
    }

    const originDevfileUrl = attributes['ORIGIN_DEVFILE'];
    const devWorkspace: V1alpha2DevWorkspace = createdWorkspace;
    if (enableTheiaLibrary) {
      console.log('Enabling Theia library for devfile', originDevfileUrl);
      // call theia library to insert all the logic
      const inversifyBindings = new InversifyBinding();
      const container = await inversifyBindings.initBindings({
        pluginRegistryUrl: pluginRegistryUrl,
        axiosInstance: this.axios,
      });
      console.log('Using plugin registry url', pluginRegistryUrl);

      const devfileCheTheiaPluginsResolver = container.get(DevfileCheTheiaPluginsResolver);
      // call library to update devWorkspace and add optional templates
      await devfileCheTheiaPluginsResolver.handle({
        devfileUrl: originDevfileUrl,
        namespace,
        devWorkspace,
        devWorkspaceTemplates,
      });
    }

    console.log('Found devWorkspace being updated to', JSON.stringify(devWorkspace));
    console.log('Found devWorkspaceTemplates length is', devWorkspaceTemplates.length);
    console.log('Found devWorkspaceTemplates being updated to', JSON.stringify(devWorkspaceTemplates));

    await Promise.all(devWorkspaceTemplates.map(async template => {
      const theiaDWT = await this.dwtApi.create(<IDevWorkspaceTemplate>template);
      console.log(`Creating template with name ${theiaDWT.metadata.name}`);

      const kubernetesPlugin = {
        name: theiaDWT.metadata.name,
        plugin: {
          kubernetes: {
            name: theiaDWT.metadata.name,
            namespace: theiaDWT.metadata.namespace
          }
        }
      };
      console.log('Adding kuubernetes plugin', kubernetesPlugin);
      // update workspace
      createdWorkspace.spec?.template?.components?.push(kubernetesPlugin);
    }));

    (<IDevWorkspace>createdWorkspace).spec.started = true;
    const updatedWorkspace = await this.workspaceApi.update(<IDevWorkspace>createdWorkspace);

    return convertDevWorkspaceV2ToV1(updatedWorkspace);
  }

  delete(namespace: string, name: string): void {
    this.workspaceApi.delete(namespace, name);
  }

  async changeWorkspaceStatus(namespace: string, name: string, started: boolean): Promise<che.Workspace> {
    const changedWorkspace = await this.workspaceApi.changeStatus(namespace, name, started);
    this.checkForDevWorkspaceError(changedWorkspace);
    return convertDevWorkspaceV2ToV1(changedWorkspace);
  }

  /**
   * Initialize the given namespace
   * @param namespace The namespace you want to initialize
   * @returns If the namespace has been initialized
   */
  async initializeNamespace(namespace: string): Promise<boolean> {
    try {
      this.initializing = new Promise((resolve, reject) => {
        this.workspaceApi.initializeNamespace(namespace).then(_ => {
          resolve(undefined);
        });
      });
      await this.initializing;
    } catch (e) {
      console.error(e);
      return false;
    }
    return true;
  }

  subscribeToNamespace(
    defaultNamespace: string,
    callback: any,
    dispatch: any
  ): void {
    setInterval(async () => {
      // This is a temporary solution until websockets work. Ideally we should just have a websocket connection here.
      const devworkspaces = await this.getAllWorkspaces(defaultNamespace);
      devworkspaces.forEach((devworkspace: che.Workspace) => {
        const statusUpdate = this.createStatusUpdate(devworkspace);
        callback(
          {
            id: devworkspace.id,
          } as che.Workspace,
          statusUpdate
        )(dispatch);
      });
    }, 1000);
  }

  /**
   * Create a status update between the previously recieving DevWorkspace with a certain workspace id
   * and the new DevWorkspace
   * @param devworkspace The incoming DevWorkspace
   */
  private createStatusUpdate(devworkspace: che.Workspace): IStatusUpdate {
    const namespace = devworkspace.namespace as string;
    const workspaceId = devworkspace.id;
    // Starting devworkspaces don't have status defined
    const status = devworkspace.status && typeof devworkspace.status === 'string' ? devworkspace.status.toUpperCase() : WorkspaceStatus[WorkspaceStatus.STARTING];

    const prevWorkspace = this.previousItems.get(namespace);
    if (prevWorkspace) {
      const prevStatus = prevWorkspace.get(workspaceId);
      const newUpdate: IStatusUpdate = {
        workspaceId: workspaceId,
        status: status,
        prevStatus: prevStatus?.status,
      };
      prevWorkspace.set(workspaceId, newUpdate);
      return newUpdate;
    } else {
      // there is not a previous update
      const newStatus: IStatusUpdate = {
        workspaceId,
        status: status,
        prevStatus: status,
      };

      const newStatusMap = new Map<string, IStatusUpdate>();
      newStatusMap.set(workspaceId, newStatus);
      this.previousItems.set(namespace, newStatusMap);
      return newStatus;
    }
  }

  checkForDevWorkspaceError(devworkspace: IDevWorkspace) {
    const currentPhase = devworkspace.status?.phase;
    if (currentPhase && currentPhase.toUpperCase() === DevWorkspaceStatus[DevWorkspaceStatus.FAILED]) {
      const message = devworkspace.status.message;
      if (message) {
        throw new Error(devworkspace.status.message);
      }
      throw new Error('Unknown error occured when trying to process the devworkspace');
    }
  }
}
