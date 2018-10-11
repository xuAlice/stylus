/* global detectSloppyRegexps download prefs openURL FIREFOX CHROME VIVALDI
  openEditor debounce URLS ignoreChromeError queryTabs getTab
  usercss styleManager db msg navigatorUtil iconUtil */
'use strict';

// eslint-disable-next-line no-var
var backgroundWorker = workerUtil.createWorker({
  url: '/background/background-worker.js'
});

window.API_METHODS = Object.assign(window.API_METHODS || {}, {
  getSectionsByUrl: styleManager.getSectionsByUrl,
  getSectionsById: styleManager.getSectionsById,
  getStylesInfo: styleManager.getStylesInfo,
  toggleStyle: styleManager.toggleStyle,
  deleteStyle: styleManager.deleteStyle,
  getStylesInfoByUrl: styleManager.getStylesInfoByUrl,
  installStyle: styleManager.installStyle,
  editSave: styleManager.editSave,

  getTabUrlPrefix() {
    return this.sender.tab.url.match(/^([\w-]+:\/+[^/#]+)/)[1];
  },

  getStyleFromDB: id =>
    db.exec('get', id).then(event => event.target.result),

  download(msg) {
    delete msg.method;
    return download(msg.url, msg);
  },
  parseCss({code}) {
    return backgroundWorker.parseMozFormat({code});
  },
  getPrefs: prefs.getAll,

  // FIXME: who uses this?
  healthCheck: () => db.exec().then(() => true),

  detectSloppyRegexps,
  openEditor,

  updateIconBadge(count) {
    return updateIconBadge(this.sender.tab.id, count);
  },

  // exposed for stuff that requires followup sendMessage() like popup::openSettings
  // that would fail otherwise if another extension forced the tab to open
  // in the foreground thus auto-closing the popup (in Chrome)
  openURL,

  // FIXME: who use this?
  closeTab: (msg, sender, respond) => {
    chrome.tabs.remove(msg.tabId || sender.tab.id, () => {
      if (chrome.runtime.lastError && msg.tabId !== sender.tab.id) {
        respond(new Error(chrome.runtime.lastError.message));
      }
    });
    return true;
  },

  optionsCustomizeHotkeys() {
    return browser.runtime.openOptionsPage()
      .then(() => new Promise(resolve => setTimeout(resolve, 100)))
      .then(() => msg.broadcastExtension({method: 'optionsCustomizeHotkeys'}));
  },
});

// eslint-disable-next-line no-var
var browserCommands, contextMenus;

// *************************************************************************
// register all listeners
msg.on(onRuntimeMessage);

// if (FIREFOX) {
  // see notes in apply.js for getStylesFallback
  // const MSG_GET_STYLES = 'getStyles:';
  // const MSG_GET_STYLES_LEN = MSG_GET_STYLES.length;
  // chrome.runtime.onConnect.addListener(port => {
    // if (!port.name.startsWith(MSG_GET_STYLES)) return;
    // const tabId = port.sender.tab.id;
    // const frameId = port.sender.frameId;
    // const options = tryJSONparse(port.name.slice(MSG_GET_STYLES_LEN));
    // port.disconnect();
    // FIXME: getStylesFallback?
    // getStyles(options).then(styles => {
      // if (!styles.length) return;
      // chrome.tabs.executeScript(tabId, {
        // code: `
          // applyOnMessage({
            // method: 'styleApply',
            // styles: ${JSON.stringify(styles)},
          // })
        // `,
        // runAt: 'document_start',
        // frameId,
      // });
    // });
  // });
// }

navigatorUtil.onUrlChange(({tabId, frameId}, type) => {
  if (type === 'committed') {
    // styles would be updated when content script is injected.
    return;
  }
  msg.sendTab(tabId, {method: 'urlChanged'}, {frameId})
    .catch(msg.broadcastError);
});

if (FIREFOX) {
  // FF applies page CSP even to content scripts, https://bugzil.la/1267027
  navigatorUtil.onCommitted(webNavUsercssInstallerFF, {
    url: [
      {hostSuffix: '.githubusercontent.com', urlSuffix: '.user.css'},
      {hostSuffix: '.githubusercontent.com', urlSuffix: '.user.styl'},
    ]
  });
  // FF misses some about:blank iframes so we inject our content script explicitly
  navigatorUtil.onDOMContentLoaded(webNavIframeHelperFF, {
    url: [
      {urlEquals: 'about:blank'},
    ]
  });
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) =>
    contextMenus[info.menuItemId].click(info, tab));
}

if (chrome.commands) {
  // Not available in Firefox - https://bugzilla.mozilla.org/show_bug.cgi?id=1240350
  chrome.commands.onCommand.addListener(command => browserCommands[command]());
}

const tabIcons = new Map();
chrome.tabs.onRemoved.addListener(tabId => tabIcons.delete(tabId));
chrome.tabs.onReplaced.addListener((added, removed) => tabIcons.delete(removed));

prefs.subscribe([
  'disableAll',
  'badgeDisabled',
  'badgeNormal',
], () => debounce(refreshIconBadgeColor));

prefs.subscribe([
  'show-badge'
], () => debounce(refreshIconBadgeText));

prefs.subscribe([
  'disableAll',
  'iconset',
], () => debounce(refreshAllIcons));

prefs.initializing.then(() => {
  refreshIconBadgeColor();
  refreshAllIconsBadgeText();
  refreshAllIcons();
});

navigatorUtil.onUrlChange(({tabId, frameId}, type) => {
  if (type === 'committed' && !frameId) {
    // it seems that the tab icon would be reset when pressing F5. We
    // invalidate the cache here so it would be refreshed.
    tabIcons.delete(tabId);
  }
});

// *************************************************************************
chrome.runtime.onInstalled.addListener(({reason}) => {
  if (reason !== 'update') return;
  // translations may change
  localStorage.L10N = JSON.stringify({
    browserUIlanguage: chrome.i18n.getUILanguage(),
  });
  // themes may change
  delete localStorage.codeMirrorThemes;
});

// *************************************************************************
// browser commands
browserCommands = {
  openManage() {
    openURL({url: 'manage.html'});
  },
  styleDisableAll(info) {
    prefs.set('disableAll', info ? info.checked : !prefs.get('disableAll'));
  },
};

// *************************************************************************
// context menus
contextMenus = {
  'show-badge': {
    title: 'menuShowBadge',
    click: info => prefs.set(info.menuItemId, info.checked),
  },
  'disableAll': {
    title: 'disableAllStyles',
    click: browserCommands.styleDisableAll,
  },
  'open-manager': {
    title: 'openStylesManager',
    click: browserCommands.openManage,
  },
  'editor.contextDelete': {
    presentIf: () => !FIREFOX && prefs.get('editor.contextDelete'),
    title: 'editDeleteText',
    type: 'normal',
    contexts: ['editable'],
    documentUrlPatterns: [URLS.ownOrigin + 'edit*'],
    click: (info, tab) => {
      msg.sendTab(tab.id, {method: 'editDeleteText'});
    },
  }
};

if (chrome.contextMenus) {
  const createContextMenus = ids => {
    for (const id of ids) {
      let item = contextMenus[id];
      if (item.presentIf && !item.presentIf()) {
        continue;
      }
      item = Object.assign({id}, item);
      delete item.presentIf;
      item.title = chrome.i18n.getMessage(item.title);
      if (!item.type && typeof prefs.defaults[id] === 'boolean') {
        item.type = 'checkbox';
        item.checked = prefs.get(id);
      }
      if (!item.contexts) {
        item.contexts = ['browser_action'];
      }
      delete item.click;
      chrome.contextMenus.create(item, ignoreChromeError);
    }
  };

  // circumvent the bug with disabling check marks in Chrome 62-64
  const toggleCheckmark = CHROME >= 3172 && CHROME <= 3288 ?
    (id => chrome.contextMenus.remove(id, () => createContextMenus([id]) + ignoreChromeError())) :
    ((id, checked) => chrome.contextMenus.update(id, {checked}, ignoreChromeError));

  const togglePresence = (id, checked) => {
    if (checked) {
      createContextMenus([id]);
    } else {
      chrome.contextMenus.remove(id, ignoreChromeError);
    }
  };

  const keys = Object.keys(contextMenus);
  prefs.subscribe(keys.filter(id => typeof prefs.defaults[id] === 'boolean'), toggleCheckmark);
  prefs.subscribe(keys.filter(id => contextMenus[id].presentIf), togglePresence);
  createContextMenus(keys);
}

// reinject content scripts when the extension is reloaded/updated. Firefox
// would handle this automatically.
if (!FIREFOX) {
  reinjectContentScripts();
}

// register hotkeys
if (FIREFOX && browser.commands && browser.commands.update) {
  const hotkeyPrefs = Object.keys(prefs.defaults).filter(k => k.startsWith('hotkey.'));
  prefs.subscribe(hotkeyPrefs, (name, value) => {
    try {
      name = name.split('.')[1];
      if (value.trim()) {
        browser.commands.update({name, shortcut: value});
      } else {
        browser.commands.reset(name);
      }
    } catch (e) {}
  });
}

function reinjectContentScripts() {
  const NTP = 'chrome://newtab/';
  const ALL_URLS = '<all_urls>';
  const contentScripts = chrome.runtime.getManifest().content_scripts;
  // expand * as .*?
  const wildcardAsRegExp = (s, flags) => new RegExp(
      s.replace(/[{}()[\]/\\.+?^$:=!|]/g, '\\$&')
        .replace(/\*/g, '.*?'), flags);
  for (const cs of contentScripts) {
    cs.matches = cs.matches.map(m => (
      m === ALL_URLS ? m : wildcardAsRegExp(m)
    ));
  }

  const injectCS = (cs, tabId) => {
    ignoreChromeError();
    for (const file of cs.js) {
      chrome.tabs.executeScript(tabId, {
        file,
        runAt: cs.run_at,
        allFrames: cs.all_frames,
        matchAboutBlank: cs.match_about_blank,
      }, ignoreChromeError);
    }
  };

  const pingCS = (cs, {id, url}) => {
    cs.matches.some(match => {
      if ((match === ALL_URLS || url.match(match)) &&
          (!url.startsWith('chrome') || url === NTP)) {
        msg.sendTab(id, {method: 'ping'})
          .catch(() => false)
          .then(pong => !pong && injectCS(cs, id));
        return true;
      }
    });
  };

  queryTabs().then(tabs =>
    tabs.forEach(tab => {
      // skip lazy-loaded aka unloaded tabs that seem to start loading on message in FF
      if (tab.width) {
        contentScripts.forEach(cs =>
          setTimeout(pingCS, 0, cs, tab));
      }
    }));
}

function webNavUsercssInstallerFF(data) {
  const {tabId} = data;
  Promise.all([
    msg.sendTab(tabId, {method: 'ping'})
      .catch(() => false),
    // we need tab index to open the installer next to the original one
    // and also to skip the double-invocation in FF which assigns tab url later
    getTab(tabId),
  ]).then(([pong, tab]) => {
    if (pong !== true && tab.url !== 'about:blank') {
      window.API_METHODS.openUsercssInstallPage({direct: true}, {tab});
    }
  });
}


function webNavIframeHelperFF({tabId, frameId}) {
  if (!frameId) return;
  msg.sendTab(tabId, {method: 'ping'}, {frameId})
    .catch(() => false)
    .then(pong => {
      if (pong) return;
      // insert apply.js to iframe
      const files = chrome.runtime.getManifest().content_scripts[0].js;
      for (const file of files) {
        chrome.tabs.executeScript(tabId, {
          frameId,
          file,
          matchAboutBlank: true,
        }, ignoreChromeError);
      }
    });
}

function updateIconBadge(tabId, count) {
  let tabIcon = tabIcons.get(tabId);
  if (!tabIcon) tabIcons.set(tabId, (tabIcon = {}));
  if (tabIcon.count === count) {
    return;
  }
  const oldCount = tabIcon.count;
  tabIcon.count = count;
  refreshIconBadgeText(tabId, tabIcon);
  if (Boolean(oldCount) !== Boolean(count)) {
    refreshIcon(tabId, tabIcon);
  }
}

function refreshIconBadgeText(tabId, icon) {
  iconUtil.setBadgeText({
    text: prefs.get('show-badge') && icon.count ? String(icon.count) : '',
    tabId
  });
}

function refreshIcon(tabId, icon) {
  const disableAll = prefs.get('disableAll');
  const iconset = prefs.get('iconset') === 1 ? 'light/' : '';
  const postfix = disableAll ? 'x' : !icon.count ? 'w' : '';
  const iconType = iconset + postfix;

  if (icon.iconType === iconType) {
    return;
  }
  icon.iconType = iconset + postfix;
  const sizes = FIREFOX || CHROME >= 2883 && !VIVALDI ? [16, 32] : [19, 38];
  iconUtil.setIcon({
    path: sizes.reduce(
      (obj, size) => {
        obj[size] = `/images/icon/${iconset}${size}${postfix}.png`;
        return obj;
      },
      {}
    ),
    tabId
  });
}

function refreshIconBadgeColor() {
  const color = prefs.get(prefs.get('disableAll') ? 'badgeDisabled' : 'badgeNormal');
  iconUtil.setBadgeBackgroundColor({
    color
  });
}

function refreshAllIcons() {
  for (const [tabId, icon] of tabIcons) {
    refreshIcon(tabId, icon);
  }
  refreshIcon(null, {}); // default icon
}

function refreshAllIconsBadgeText() {
  for (const [tabId, icon] of tabIcons) {
    refreshIconBadgeText(tabId, icon);
  }
}

function onRuntimeMessage(msg, sender) {
  if (msg.method !== 'invokeAPI') {
    return;
  }
  const fn = window.API_METHODS[msg.name];
  if (!fn) {
    throw new Error(`unknown API: ${msg.name}`);
  }
  const context = {msg, sender};
  return fn.apply(context, msg.args);
}

function openEditor({id}) {
  let url = '/edit.html';
  if (id) {
    url += `?id=${id}`;
  }
  if (chrome.windows && prefs.get('openEditInWindow')) {
    chrome.windows.create(Object.assign({url}, prefs.get('windowPosition')));
  } else {
    openURL({url});
  }
}
