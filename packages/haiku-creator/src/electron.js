import * as EventEmitter from 'events';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import {parse} from 'url';
import {inherits} from 'util';

import {BrowserWindow, app, ipcMain, protocol, systemPreferences, session} from 'electron';
import * as ElectronProxyAgent from 'electron-proxy-agent';
import * as qs from 'qs';

import * as fs from 'fs';

import {isProxied, ProxyType} from 'haiku-common/lib/proxies';
import TopMenu from 'haiku-common/lib/electron/TopMenu';
import * as mixpanel from 'haiku-serialization/src/utils/Mixpanel';
import * as ensureTrailingSlash from 'haiku-serialization/src/utils/ensureTrailingSlash';
import * as logger from 'haiku-serialization/src/utils/LoggerInstance';
import {isMac, isWindows} from 'haiku-common/lib/environments/os';
import _ from 'lodash';
import { writeJSON } from 'fs-extra';

if (!app) {
  throw new Error('You can only run electron.js from an electron process');
}

app.setName('Haiku Animator');
app.setAsDefaultProtocolClient('haiku');

const {dialog} = require('electron');

//////////
//BEGIN HACK:  take over the electron process, patch user through a sequence of dialogs to
//////         select the active folder; pass the selected folder directly into plumbing.
///            This bypasses all network hooks and was a relatively easy way to prepare this for open-sourcing.

//You enter a dimly lit room.  Ahead are three options:
let activeFolder = "";
let mode = dialog.showMessageBox({
  message: "Welcome to Haiku Animator!",
  type: "question",
  buttons: ["New project...", "Open project...", "Exit"]
});

if(mode === 0){ //You choose to create a new project.  You take a deep breath, then:

  let folderIsEmpty = false;
  let folder = "";
  while(!folderIsEmpty) {
    dialog.showMessageBox({
      message: "On the coming screen, select an empty directory for this project.",
      type: "info",
      buttons: ["OK"],
    });
    
    let files = dialog.showOpenDialog({properties: ["openDirectory", "showHiddenFiles", "createDirectory"] });

    //User canceled! Game over.
    if(!files || !files.length){
      process.kill(0);
    }

    folder = files[0];

    folderIsEmpty = fs.readdirSync(folder).length === 0;
  }

  //with an assurance that folderIsEmpty, we can proceed to mount a new project to `folder`
  activeFolder = folder


}else if(mode === 1) { //You are sure that Open is the way to go.  Without hesitation, you charge ahead:
  dialog.showMessageBox({
    message: "On the coming screen, select a directory containing a Haiku Animator project. \r\n\r\nFor legacy commercial projects, check ~/.haiku/projects",
    type: "info",
    buttons: ["OK"],
  });

  let files = dialog.showOpenDialog({properties: ["openDirectory", "showHiddenFiles"] });

  //User canceled!  Game over.
  if(!files || !files.length){
    process.kill(0);
  }

  //payload
  activeFolder = files[0]

}else { //You turn around and head back from whence you came.  
  process.kill(0);
}

//////////
//END HACK (hard-coded folder)
/////

// Haiku main window
let browserWindow = null;

const handleUrl = (url) => {
  if (!browserWindow) {
    logger.warn(`[creator] unable to handle custom protocol URL ${url}; browserWindow not ready`);
    return;
  }
  logger.info(`[creator] handling custom protocol URL ${url}`);
  const parsedUrl = parse(url);
  browserWindow.webContents.send(`open-url:${parsedUrl.host}`, parsedUrl.pathname, qs.parse(parsedUrl.query));
};

// Disable "Start Dictation" and "Emoji & Symbols" menu items on MAC
if (isMac()) {
  systemPreferences.setUserDefault('NSDisabledDictationMenuItem', 'boolean', true);
  systemPreferences.setUserDefault('NSDisabledCharacterPaletteMenuItem', 'boolean', true);
}

app.on('login', (event, webContents, request, authInfo, authenticate) => {
  // We are currently not equipped to authenticate requests that are intercepted by a proxy but require login
  // credentials when we encounter interference at this stage. When this functionality is added:
  //   - `event.preventDefault()` will prevent the default behavior of Electron blocking the request.
  //   - Invoking the callback like `authenticate(username, password)` should allow the authenticated-proxied request
  //     through.
  // For now, log the authorization info so we can at least see what's going on.
  logger.warn('[unexpected proxy interference]', authInfo);
});

// See bottom
function CreatorElectron () {
  EventEmitter.apply(this);
}
inherits(CreatorElectron, EventEmitter);
const creator = new CreatorElectron();

const appUrl = 'file://' + path.join(__dirname, '..', 'index.html');

// Plumbing starts up this process, and it uses HAIKU_ENV to forward to us data about
// how it has been set up, e.g. what ports it is using for websocket server, envoy, etc.
// This is sent into the DOM part of the app at did-finish load; see below.
const haiku = global.process.env.HAIKU_ENV
  ? JSON.parse(global.process.env.HAIKU_ENV)
  : {};



//////////
//BEGIN HACK:  (part 2)
//////         
///

//hook up folder selected by dialog GUI above.
//plumbing special-cases the situation where `haiku.folder` is
//specified and bypasses all network hooks
haiku.folder = activeFolder;

//////////
//END HACK (part 2)
/////


app.on('window-all-closed', () => {
  app.quit();
});

if (!haiku.plumbing) {
  haiku.plumbing = {};
}

if (!haiku.plumbing.url) {
  if (global.process.env.NODE_ENV !== 'test' && !global.process.env.HAIKU_PLUMBING_PORT) {
    throw new Error(`Oops! You must define a HAIKU_PLUMBING_PORT env var!`);
  }

  // tslint:disable-next-line:max-line-length
  haiku.plumbing.url = `http://${global.process.env.HAIKU_PLUMBING_HOST || '0.0.0.0'}:${global.process.env.HAIKU_PLUMBING_PORT}/?token=${process.env.HAIKU_WS_SECURITY_TOKEN}`;
}

function createWindow () {

  // Before doing anything, ensure we are not in a second instance of the app, if we are, let's short-cirtuit
  // and let the open instance handle the request.
  if (!isMac()) {
    const isSecondInstance = app.makeSingleInstance((commandLine, workingDirectory) => {
      logger.info(`[creator] Received command line on second instance ${commandLine}`);

      // Handle haiku:// protocol on second instance
      for (const arg of commandLine) {
        if (arg.startsWith('haiku://')) {
          handleUrl(arg);
          break;
        }
      }

      // Someone tried to run a second instance, we should focus our window.
      if (browserWindow) {
        if (browserWindow.isMinimized()) {
          browserWindow.restore();
        }
        browserWindow.focus();
      }
    });

    if (isSecondInstance) {
      app.quit();
      return;
    }
  }

  logger.view = 'main';
  mixpanel.haikuTrack('app:initialize');

  browserWindow = new BrowserWindow({
    title: 'Haiku Animator',
    show: false, // Don't show the window until we are ready-to-show (see below)
    titleBarStyle: 'hiddenInset',
    minWidth: 700,
    minHeight: 650,
    backgroundColor: '#343f41',
  });

  const topmenu = new TopMenu(browserWindow.webContents);

  const topmenuOptions = {
    projectsList: [],
    isSaving: false,
    isProjectOpen: false,
    subComponents: [],
    undoState: {canUndo: false, canRedo: false},
  };

  topmenu.create(topmenuOptions);

  ipcMain.on('topmenu:update', (_, nextTopmenuOptions) => {
    topmenu.update(nextTopmenuOptions);
  });

  ipcMain.on('restart', () => {
    app.relaunch();
    browserWindow.close();
  });

  // Emitted by Creator during project bootstrapping, this ensures image URLs like web+haikuroot://assets/designs/…
  // display correctly in thumbnails.
  ipcMain.on('protocol:register', (_, projectPath) => {
    protocol.registerFileProtocol('web+haikuroot', (request, cb) => {
      cb(ensureTrailingSlash(projectPath) + request.url.substr(16));
    });
  });

  // We also need to be able to tear down the protocol when a project is shut down.
  ipcMain.on('protocol:unregister', () => {
    protocol.unregisterProtocol('web+haikuroot');
  });

  browserWindow.setTitle('Haiku Animator');
  browserWindow.maximize();
  browserWindow.loadURL(appUrl);

  if (process.env.DEV === '1' || process.env.DEV === 'creator') {
    browserWindow.openDevTools();
  }

  // Sending our haiku configuration into the view so it can correctly set up
  // its own websocket connections to our plumbing server, etc.
  browserWindow.webContents.on('did-finish-load', () => {
    const ses = session.fromPartition('persist:name');
    https.globalAgent = http.globalAgent = new ElectronProxyAgent(session.defaultSession);

    ses.resolveProxy(haiku.plumbing.url, (proxy) => {
      haiku.proxy = {
        // Proxy URL will come through in PAC syntax, e.g. `PROXY secure.megacorp.com:3128`
        // @see {@link https://en.wikipedia.org/wiki/Proxy_auto-config}
        url: proxy.replace(`${ProxyType.Proxied} `, ''),
        active: isProxied(proxy),
      };

      browserWindow.webContents.send('haiku', haiku);
      if (global.process.env.HAIKU_INITIAL_URL) {
        handleUrl(global.process.env.HAIKU_INITIAL_URL);
        delete global.process.env.HAIKU_INITIAL_URL;
      }
    });
  });

  browserWindow.on('closed', () => {
    browserWindow = null;
  });

  browserWindow.on('ready-to-show', () => {
    browserWindow.show();
  });

  if (isWindows()) {
    ipcMain.on('app:check-updates', () => {
      windowsCheckForUpdates();
    });

    setInterval(() => {
      windowsCheckForUpdates();
    }, 1000 * 60 * 60);

    windowsCheckForUpdates();
  }
}

function windowsCheckForUpdates () {
  if (!isWindows()) {
    return;
  }

  const {autoUpdater} = require('electron-updater');
  autoUpdater.setFeedURL('https://releases.haiku.ai/releases/');
  autoUpdater.checkForUpdates().then(({downloadPromise}) => {
    if (downloadPromise == null) {
      return;
    }

    downloadPromise
      .then(() => {
        const dialog = require('electron').dialog;
        const userResponse = dialog.showMessageBox({
          type: 'none',
          message:
            'Haiku will be automatically updated next time you start the app. Would you like to restart Haiku now?',
          buttons: ['No', 'Yes'],
          defaultId: 1,
        });

        if (userResponse === 1) {
          autoUpdater.quitAndInstall();
          return;
        }
      })
      .catch((error) => {
        console.log(error);
      });
  });
}

// Transmit haiku://foo/bar?baz=bat as the "open-url:foo" event with arguments [_, "/bar", {"baz": "bat"}]
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleUrl(url);
});

if (app.isReady()) {
  createWindow();
} else {
  app.on('ready', createWindow);
}

// Hacky: When plumbing launches inside an Electron process it expects an EventEmitter-like
// object as the export, so we expose this here even though it doesn't do much
module.exports = {
  default: creator,
};
