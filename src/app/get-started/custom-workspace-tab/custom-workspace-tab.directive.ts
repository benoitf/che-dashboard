/*
 * Copyright (c) 2015-2018 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */
'use strict';

export class CustomWorkspaceTabDirective implements ng.IDirective {

  templateUrl = 'app/get-started/custom-workspace-tab/custom-workspace-tab.html';

  bindToController = true;
  controller = 'CustomWorkspaceTabController';
  controllerAs = 'customWorkspaceTabController';

}
