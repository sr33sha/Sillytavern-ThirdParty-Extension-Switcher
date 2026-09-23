import { extension_settings } from "../../../extensions.js";
// Namespace imports on purpose: a missing named export would throw at load time and kill the whole
// extension, while a missing property on a namespace object is just undefined. Tauri Tavern and
// SillyTavern don't necessarily export the same things, and this has to run on both.
import * as extensionsModule from "../../../extensions.js";
import * as scriptModule from "../../../../script.js";

const SETTINGS_KEY = "rpModeSwitch";
const THIRD_PARTY_PREFIX = "third-party/";
const POSITION_KEY = "tt-rp-switch-position";
const BUTTON_SIZE = 40;
const DRAG_THRESHOLD_PX = 5;
const PANEL_GAP_PX = 8;

// Never offered in the list - disabling the switcher from inside the switcher would strand the user.
const OWN_FOLDER = (() => {
    try {
        const match = new URL(import.meta.url).pathname.match(/\/third-party\/([^/]+)\//);
        return match ? decodeURIComponent(match[1]) : null;
    } catch {
        return null;
    }
})();
const SELF_IDS = new Set([OWN_FOLDER].filter(Boolean).map((name) => THIRD_PARTY_PREFIX + name));

function saveSettings() {
    scriptModule.saveSettingsDebounced?.();
}

//#region Which extensions are in the switcher (synced with settings)

// There is deliberately no built-in list: nobody knows which extensions another user has installed.
// Until the user has picked something, the panel opens straight into the picker.
function isConfigured() {
    return Array.isArray(extension_settings[SETTINGS_KEY]?.selected);
}

function getSelected() {
    return isConfigured() ? extension_settings[SETTINGS_KEY].selected : [];
}

function setSelected(id, included) {
    if (!isConfigured()) {
        extension_settings[SETTINGS_KEY] = { selected: [] };
    }
    const selected = extension_settings[SETTINGS_KEY].selected;
    const idx = selected.indexOf(id);
    if (included && idx === -1) {
        selected.push(id);
    } else if (!included && idx !== -1) {
        selected.splice(idx, 1);
    }
    saveSettings();
}

//#endregion

//#region Enabling / disabling (same array the native Manage Extensions toggle writes)

function isExtensionDisabled(id) {
    return Array.isArray(extension_settings.disabledExtensions) && extension_settings.disabledExtensions.includes(id);
}

function setExtensionDisabled(id, disabled) {
    if (!Array.isArray(extension_settings.disabledExtensions)) {
        extension_settings.disabledExtensions = [];
    }
    const list = extension_settings.disabledExtensions;
    const idx = list.indexOf(id);
    if (disabled && idx === -1) {
        list.push(id);
    } else if (!disabled && idx !== -1) {
        list.splice(idx, 1);
    }
    saveSettings();
}

//#endregion

//#region Finding installed third-party extensions

/** Accepts "third-party/Foo", "/third-party/Foo" or {type, name} objects. Returns "third-party/Foo" or null. */
function toThirdPartyId(raw) {
    let name = typeof raw === "string" ? raw : raw?.name;
    if (typeof name !== "string") {
        return null;
    }
    name = name.replace(/^\/+/, "");
    if (typeof raw === "object" && raw?.type === "third-party" && !name.startsWith(THIRD_PARTY_PREFIX)) {
        name = THIRD_PARTY_PREFIX + name;
    }
    return name.startsWith(THIRD_PARTY_PREFIX) && name.length > THIRD_PARTY_PREFIX.length ? name : null;
}

function collectIds(list) {
    const items = Array.isArray(list) ? list : Array.isArray(list?.extensions) ? list.extensions : [];
    return items.map(toThirdPartyId).filter(Boolean);
}

/** Tries each known way to list extensions, in order. Reports which one worked, to make problems diagnosable. */
async function discoverThirdPartyIds() {
    // 1. SillyTavern's own module state.
    let ids = collectIds(extensionsModule.extensionNames);
    if (ids.length) {
        return { ids, via: "extensionNames" };
    }

    // 2. SillyTavern's discovery endpoint (Tauri Tavern may serve it too).
    try {
        const response = await fetch("/api/extensions/discover", {
            method: "GET",
            headers: scriptModule.getRequestHeaders?.() ?? {},
        });
        if (response.ok) {
            ids = collectIds(await response.json());
            if (ids.length) {
                return { ids, via: "/api/extensions/discover" };
            }
        }
    } catch (error) {
        console.debug("[Extension Switcher] discover endpoint failed", error);
    }

    // 3. Tauri Tavern's backend command directly.
    try {
        const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke === "function") {
            ids = collectIds(await invoke("get_extensions"));
            if (ids.length) {
                return { ids, via: "tauri get_extensions" };
            }
        }
    } catch (error) {
        console.debug("[Extension Switcher] tauri get_extensions failed", error);
    }

    return { ids: [], via: null };
}

let installedPromise = null;
function getInstalled() {
    if (!installedPromise) {
        installedPromise = discoverThirdPartyIds().then((result) => {
            if (result.via) {
                console.info(`[Extension Switcher] listed ${result.ids.length} third-party extensions via ${result.via}`);
            } else {
                console.warn("[Extension Switcher] couldn't list installed extensions by any method");
                installedPromise = null; // try again next time the panel opens
            }
            return result;
        });
    }
    return installedPromise;
}

function getLabel(id) {
    const folder = id.slice(THIRD_PARTY_PREFIX.length);
    const manifests = extensionsModule.manifests;
    const manifest = manifests?.[id] ?? manifests?.[`/${id}`] ?? manifests?.[folder];
    return manifest?.display_name || folder;
}

//#endregion

//#region Position

// Stored per-device in localStorage on purpose: extension_settings syncs between PC and Android,
// and a position that's on-screen on a monitor can be off-screen on a phone.
function loadPosition() {
    try {
        const saved = JSON.parse(localStorage.getItem(POSITION_KEY));
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
            return saved;
        }
    } catch {
        // fall through to default
    }
    return { left: 12, top: window.innerHeight - 130 };
}

function savePosition(left, top) {
    try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({ left, top }));
    } catch {
        // storage unavailable - position just won't persist
    }
}

/** Places the button, clamped so it can never end up off-screen. Returns the applied position. */
function placeButton(button, left, top) {
    const clampedLeft = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - BUTTON_SIZE));
    const clampedTop = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - BUTTON_SIZE));
    button.style.left = `${clampedLeft}px`;
    button.style.top = `${clampedTop}px`;
    return { left: clampedLeft, top: clampedTop };
}

/** Anchors the panel next to the button - above it if there's room, otherwise below. */
function placePanel(button, panel) {
    const rect = button.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;

    let top = rect.top - panelHeight - PANEL_GAP_PX;
    if (top < 0) {
        top = rect.bottom + PANEL_GAP_PX;
    }
    const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - panelWidth));
    top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - panelHeight));

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

//#endregion

//#region Dragging

/** Pointer events cover mouse and touch alike. A press that barely moves counts as a tap. */
function makeDraggable(button, panel, onTap) {
    let activePointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;

    button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        activePointerId = event.pointerId;
        try {
            button.setPointerCapture(event.pointerId);
        } catch {
            // capture is best-effort
        }
        const rect = button.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        dragging = false;
    });

    button.addEventListener("pointermove", (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
            return;
        }
        dragging = true;
        placeButton(button, startLeft + dx, startTop + dy);
        if (!panel.classList.contains("tt-rp-switch-hidden")) {
            placePanel(button, panel);
        }
    });

    button.addEventListener("pointerup", (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }
        activePointerId = null;
        if (dragging) {
            const rect = button.getBoundingClientRect();
            savePosition(rect.left, rect.top);
        } else {
            onTap();
        }
        dragging = false;
    });

    button.addEventListener("pointercancel", (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }
        activePointerId = null;
        if (dragging) {
            const rect = button.getBoundingClientRect();
            savePosition(rect.left, rect.top);
        }
        dragging = false;
    });
}

//#endregion

//#region Panel

function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (text !== undefined) {
        element.textContent = text;
    }
    return element;
}

function makeCheckboxRow(label, checked, onChange) {
    const row = makeElement("label", "tt-rp-switch-row");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.addEventListener("change", () => onChange(checkbox.checked));
    row.append(checkbox, makeElement("span", "", label));
    return row;
}

function makeButton(label, onClick) {
    const button = makeElement("button", "menu_button interactable tt-rp-switch-btn", label);
    button.onclick = onClick;
    return button;
}

/** Owns the panel's contents. Rebuilt from current state every time, so it can never show stale checkboxes. */
function createPanelController(panel, onContentChanged) {
    let editing = false;
    let renderToken = 0;

    async function render() {
        const token = ++renderToken;
        const installed = await getInstalled();
        if (token !== renderToken) {
            return; // a newer render started while we were waiting
        }

        const installedIds = installed.ids.filter((id) => !SELF_IDS.has(id));
        const installedSet = new Set(installedIds);
        const listKnown = installed.via !== null;
        const content = document.createDocumentFragment();

        if (editing) {
            content.append(makeElement("div", "tt-rp-switch-title", "Choose extensions"));
            content.append(makeElement("div", "tt-rp-switch-hint", "Ticked ones appear in the switcher. This doesn't enable or disable anything."));

            if (!listKnown) {
                content.append(makeElement("div", "tt-rp-switch-note", "Couldn't list the installed extensions in this app, so there's nothing to choose from."));
            } else {
                const list = makeElement("div", "tt-rp-switch-list");
                const selected = new Set(getSelected());
                installedIds
                    .map((id) => ({ id, label: getLabel(id) }))
                    .sort((a, b) => a.label.localeCompare(b.label))
                    .forEach(({ id, label }) => {
                        list.append(makeCheckboxRow(label, selected.has(id), (checked) => setSelected(id, checked)));
                    });
                content.append(list);
            }

            const buttons = makeElement("div", "tt-rp-switch-buttons");
            buttons.append(makeButton("Done", () => {
                editing = false;
                render();
            }));
            content.append(buttons);
        } else {
            content.append(makeElement("div", "tt-rp-switch-title", "Third Party Extensions"));

            // If the installed list couldn't be read, show the saved picks as they are rather than nothing.
            const visibleIds = getSelected().filter((id) => !listKnown || installedSet.has(id));
            if (visibleIds.length === 0) {
                content.append(makeElement("div", "tt-rp-switch-note", "Nothing chosen yet. Tap Edit list to pick extensions."));
            }
            visibleIds.forEach((id) => {
                content.append(makeCheckboxRow(getLabel(id), !isExtensionDisabled(id), (checked) => {
                    setExtensionDisabled(id, !checked);
                }));
            });

            content.append(makeElement("div", "tt-rp-switch-hint", "Toggle as many as you want, then reload once."));

            const buttons = makeElement("div", "tt-rp-switch-buttons");
            buttons.append(makeButton("Reload Now", () => location.reload()));
            buttons.append(makeButton("Edit list", () => {
                editing = true;
                render();
            }));
            content.append(buttons);
        }

        panel.replaceChildren(content);
        onContentChanged();
    }

    return {
        /** Called whenever the panel is opened. First time ever, there's nothing to show yet, so go pick. */
        open() {
            editing = !isConfigured();
            return render();
        },
    };
}

//#endregion

function init() {
    const toggleBtn = document.createElement("div");
    toggleBtn.id = "tt-rp-switch-toggle";
    toggleBtn.className = "fa-solid fa-toggle-on interactable";
    toggleBtn.title = "Third Party Extension Switcher (drag to move)";

    const panel = document.createElement("div");
    panel.id = "tt-rp-switch-panel";
    panel.classList.add("tt-rp-switch-hidden");

    document.body.append(toggleBtn, panel);

    const start = loadPosition();
    placeButton(toggleBtn, start.left, start.top);

    const isPanelOpen = () => !panel.classList.contains("tt-rp-switch-hidden");
    const controller = createPanelController(panel, () => {
        if (isPanelOpen()) {
            placePanel(toggleBtn, panel);
        }
    });

    makeDraggable(toggleBtn, panel, () => {
        if (isPanelOpen()) {
            panel.classList.add("tt-rp-switch-hidden");
            return;
        }
        panel.classList.remove("tt-rp-switch-hidden");
        placePanel(toggleBtn, panel);
        controller.open();
    });

    // Rotating a phone or resizing the window must never strand the button off-screen. Not saved -
    // a temporary small window shouldn't permanently move it.
    window.addEventListener("resize", () => {
        const rect = toggleBtn.getBoundingClientRect();
        placeButton(toggleBtn, rect.left, rect.top);
        if (isPanelOpen()) {
            placePanel(toggleBtn, panel);
        }
    });
}

init();
