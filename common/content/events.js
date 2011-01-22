// Copyright (c) 2006-2008 by Martin Stubenschrott <stubenschrott@vimperator.org>
// Copyright (c) 2007-2009 by Doug Kearns <dougkearns@gmail.com>
// Copyright (c) 2008-2010 by Kris Maglione <maglione.k at Gmail>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
"use strict";

/** @scope modules */

/**
 * @instance events
 */
var Events = Module("events", {
    init: function () {
        util.overlayWindow(window, {
            append: <e4x xmlns={XUL}>
                <window id={document.documentElement.id}>
                    <!--this notifies us also of focus events in the XUL
                        from: http://developer.mozilla.org/en/docs/XUL_Tutorial:Updating_Commands !-->
                    <!-- I don't think we really need this. ––Kris -->
                    <commandset id="dactyl-onfocus" commandupdater="true" events="focus"
                                oncommandupdate="dactyl.modules.events.onFocusChange(event);"/>
                    <commandset id="dactyl-onselect" commandupdater="true" events="select"
                                oncommandupdate="dactyl.modules.events.onSelectionChange(event);"/>
                </window>
            </e4x>.elements()
        });

        this._fullscreen = window.fullScreen;
        this._lastFocus = null;
        this._currentMacro = "";
        this._macroKeys = [];
        this._lastMacro = "";
        this._processors = [];

        this.sessionListeners = [];

        this._macros = storage.newMap("macros", { privateData: true, store: true });
        for (let [k, m] in this._macros)
            if (isString(m))
                m = { keys: m, timeRecorded: Date.now() };

        // NOTE: the order of ["Esc", "Escape"] or ["Escape", "Esc"]
        //       matters, so use that string as the first item, that you
        //       want to refer to within dactyl's source code for
        //       comparisons like if (key == "<Esc>") { ... }
        this._keyTable = {
            add: ["Plus", "Add"],
            back_space: ["BS"],
            count: ["count"],
            delete: ["Del"],
            escape: ["Esc", "Escape"],
            insert: ["Insert", "Ins"],
            leader: ["Leader"],
            left_shift: ["LT", "<"],
            nop: ["Nop"],
            return: ["Return", "CR", "Enter"],
            right_shift: [">"],
            space: ["Space", " "],
            subtract: ["Minus", "Subtract"]
        };

        this._pseudoKeys = set(["count", "leader", "nop"]);

        this._key_key = {};
        this._code_key = {};
        this._key_code = {};

        for (let list in values(this._keyTable))
            for (let v in values(list))
                this._key_key[v.toLowerCase()] = v;

        for (let [k, v] in Iterator(KeyEvent)) {
            k = k.substr(7).toLowerCase();
            let names = [k.replace(/(^|_)(.)/g, function (m, n1, n2) n2.toUpperCase())
                          .replace(/^NUMPAD/, "k")];
            if (k in this._keyTable)
                names = this._keyTable[k];
            this._code_key[v] = names[0];
            for (let [, name] in Iterator(names)) {
                this._key_key[name.toLowerCase()] = name;
                this._key_code[name.toLowerCase()] = v;
            }
        }

        // HACK: as Gecko does not include an event for <, we must add this in manually.
        if (!("<" in this._key_code)) {
            this._key_code["<"] = 60;
            this._key_code["lt"] = 60;
            this._code_key[60] = "lt";
        }

        this._activeMenubar = false;
        this.addSessionListener(window, "DOMMenuBarActive", this.onDOMMenuBarActive, true);
        this.addSessionListener(window, "DOMMenuBarInactive", this.onDOMMenuBarInactive, true);
        this.addSessionListener(window, "blur", this.onBlur, true);
        this.addSessionListener(window, "focus", this.onFocus, true);
        this.addSessionListener(window, "keydown", this.onKeyUpOrDown, true);
        this.addSessionListener(window, "keypress", this.onKeyPress, true);
        this.addSessionListener(window, "keyup", this.onKeyUpOrDown, true);
        this.addSessionListener(window, "mousedown", this.onMouseDown, true);
        this.addSessionListener(window, "popuphidden", this.onPopupHidden, true);
        this.addSessionListener(window, "popupshown", this.onPopupShown, true);
        this.addSessionListener(window, "resize", this.onResize, true);
    },

    destroy: function () {
        util.dump("Removing all event listeners");
        for (let args in values(this.sessionListeners))
            if (args[0].get())
                args[0].get().removeEventListener.apply(args[0].get(), args.slice(1));
    },

    /**
     * Adds an event listener for this session and removes it on
     * dactyl shutdown.
     *
     * @param {Element} target The element on which to listen.
     * @param {string} event The event to listen for.
     * @param {function} callback The function to call when the event is received.
     * @param {boolean} capture When true, listen during the capture
     *      phase, otherwise during the bubbling phase.
     */
    addSessionListener: function (target, event, callback, capture) {
        let args = Array.slice(arguments, 0);
        args[2] = this.wrapListener(callback);
        args[0].addEventListener.apply(args[0], args.slice(1));
        args[0] = Cu.getWeakReference(args[0]);
        this.sessionListeners.push(args);
    },

    /**
     * Wraps an event listener to ensure that errors are reported.
     */
    wrapListener: function wrapListener(method, self) {
        self = self || this;
        method.wrapped = wrappedListener;
        function wrappedListener(event) {
            try {
                method.apply(self, arguments);
            }
            catch (e) {
                dactyl.reportError(e);
                if (e.message == "Interrupted")
                    dactyl.echoerr("Interrupted", commandline.FORCE_SINGLELINE);
                else
                    dactyl.echoerr("Processing " + event.type + " event: " + (e.echoerr || e),
                                   commandline.FORCE_SINGLELINE);
            }
        };
        return wrappedListener;
    },

    /**
     * @property {boolean} Whether synthetic key events are currently being
     *     processed.
     */
    feedingKeys: false,

    /**
     * Initiates the recording of a key event macro.
     *
     * @param {string} macro The name for the macro.
     */
    startRecording: function (macro) {
        // TODO: ignore this like Vim?
        dactyl.assert(/[a-zA-Z0-9]/.test(macro),
                      "E354: Invalid register name: '" + macro + "'");

        modes.recording = true;

        if (/[A-Z]/.test(macro)) { // uppercase (append)
            this._currentMacro = macro.toLowerCase();
            this._macroKeys = events.fromString((this._macros.get(this._currentMacro) || { keys: "" }).keys, true)
                                    .map(events.closure.toString);
        }
        else {
            this._currentMacro = macro;
            this._macroKeys = [];
        }
    },

    finishRecording: function () {
        modes.recording = false;
        this._macros.set(this._currentMacro, {
            keys: this._macroKeys.join(""),
            timeRecorded: Date.now()
        });

        dactyl.log("Recorded " + this._currentMacro + ": " + this._macroKeys.join(""), 9);
        dactyl.echomsg("Recorded macro '" + this._currentMacro + "'");
    },

    /**
     * Replays a macro.
     *
     * @param {string} The name of the macro to replay.
     * @returns {boolean}
     */
    playMacro: function (macro) {
        let res = false;
        if (!/[a-zA-Z0-9@]/.test(macro) && macro.length == 1) {
            dactyl.echoerr("E354: Invalid register name: '" + macro + "'");
            return false;
        }

        if (macro == "@") { // use lastMacro if it's set
            if (!this._lastMacro) {
                dactyl.echoerr("E748: No previously used register");
                return false;
            }
        }
        else
            this._lastMacro = macro.toLowerCase(); // XXX: sets last played macro, even if it does not yet exist

        if (this._macros.get(this._lastMacro)) {
            // make sure the page is stopped before starting to play the macro
            try {
                window.getWebNavigation().stop(nsIWebNavigation.STOP_ALL);
            }
            catch (e) {}

            modes.replaying = true;
            res = events.feedkeys(this._macros.get(this._lastMacro).keys, { noremap: true });
            modes.replaying = false;
        }
        else
            // TODO: ignore this like Vim?
            dactyl.echoerr("Exxx: Register '" + this._lastMacro + "' not set");
        return res;
    },

    /**
     * Returns all macros matching *filter*.
     *
     * @param {string} filter A regular expression filter string. A null
     *     filter selects all macros.
     */
    getMacros: function (filter) {
        let re = RegExp(filter || "");
        return ([k, m.keys] for ([k, m] in events._macros) if (re.test(k)));
    },

    /**
     * Deletes all macros matching *filter*.
     *
     * @param {string} filter A regular expression filter string. A null
     *     filter deletes all macros.
     */
    deleteMacros: function (filter) {
        let re = RegExp(filter || "");
        for (let [item, ] in this._macros) {
            if (!filter || re.test(item))
                this._macros.remove(item);
        }
    },

    /**
     * Pushes keys onto the event queue from dactyl. It is similar to
     * Vim's feedkeys() method, but cannot cope with 2 partially-fed
     * strings, you have to feed one parseable string.
     *
     * @param {string} keys A string like "2<C-f>" to push onto the event
     *     queue. If you want "<" to be taken literally, prepend it with a
     *     "\\".
     * @param {boolean} noremap Allow recursive mappings.
     * @param {boolean} silent Whether the command should be echoed to the
     *     command line.
     * @returns {boolean}
     */
    feedkeys: function (keys, noremap, quiet, mode) {
        try {
            var wasFeeding = this.feedingKeys;
            this.feedingKeys = true;

            var wasQuiet = commandline.quiet;
            if (quiet)
                commandline.quiet = quiet;

            util.threadYield(1, true);

            for (let [, evt_obj] in Iterator(events.fromString(keys))) {
                for (let type in values(["keydown", "keyup", "keypress"])) {
                    let evt = update({}, evt_obj, { type: type });

                    if (isObject(noremap))
                        update(evt, noremap);
                    else
                        evt.noremap = !!noremap;
                    evt.isMacro = true;
                    evt.dactylMode = mode;
                    this.feedingEvent = evt;

                    let event = events.create(document.commandDispatcher.focusedWindow.document, type, evt);
                    if (!evt_obj.dactylString && !evt_obj.dactylShift && !mode)
                        events.dispatch(dactyl.focusedElement || buffer.focusedFrame, event, evt);
                    else
                        events.onKeyPress(event);
                }

                if (!this.feedingKeys)
                    break;

                // Stop feeding keys if page loading failed.
                if (modes.replaying && !this.waitForPageLoad())
                    break;
            }
        }
        catch (e) {
            util.reportError(e);
        }
        finally {
            this.feedingEvent = null;
            this.feedingKeys = wasFeeding;
            if (quiet)
                commandline.quiet = wasQuiet;
        }
    },

    /**
     * Creates an actual event from a pseudo-event object.
     *
     * The pseudo-event object (such as may be retrieved from events.fromString)
     * should have any properties you want the event to have.
     *
     * @param {Document} doc The DOM document to associate this event with
     * @param {Type} type The type of event (keypress, click, etc.)
     * @param {Object} opts The pseudo-event.
     */
    create: function (doc, type, opts) {
        var DEFAULTS = {
            HTML: {
                type: type, bubbles: true, cancelable: false
            },
            Key: {
                type: type,
                bubbles: true, cancelable: true,
                view: doc.defaultView,
                ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
                keyCode: 0, charCode: 0
            },
            Mouse: {
                type: type,
                bubbles: true, cancelable: true,
                view: doc.defaultView,
                detail: 1,
                screenX: 0, screenY: 0,
                clientX: 0, clientY: 0,
                ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
                button: 0,
                relatedTarget: null
            }
        };
        const TYPES = {
            change: "",
            click: "Mouse", mousedown: "Mouse", mouseup: "Mouse",
            mouseover: "Mouse", mouseout: "Mouse",
            keypress: "Key", keyup: "Key", keydown: "Key"
        };
        var t = TYPES[type];
        var evt = doc.createEvent((t || "HTML") + "Events");

        let defaults = DEFAULTS[t || "HTML"]
        evt["init" + t + "Event"].apply(evt, Object.keys(defaults).map(function (k) k in opts ? opts[k] : defaults[k]));
        return evt;
    },

    /**
     * Converts a user-input string of keys into a canonical
     * representation.
     *
     * <C-A> maps to <C-a>, <C-S-a> maps to <C-S-A>
     * <C- > maps to <C-Space>, <S-a> maps to A
     * << maps to <lt><lt>
     *
     * <S-@> is preserved, as in Vim, to allow untypeable key-combinations
     * in macros.
     *
     * canonicalKeys(canonicalKeys(x)) == canonicalKeys(x) for all values
     * of x.
     *
     * @param {string} keys Messy form.
     * @returns {string} Canonical form.
     */
    canonicalKeys: function (keys, unknownOk) {
        return events.fromString(keys, unknownOk).map(events.closure.toString).join("");
    },

    iterKeys: function (keys) {
        let match, re = /<.*?>?>|[^<]/g;
        while (match = re.exec(keys))
            yield match[0];
    },

    /**
     * Dispatches an event to an element as if it were a native event.
     *
     * @param {Node} target The DOM node to which to dispatch the event.
     * @param {Event} event The event to dispatch.
     */
    dispatch: Class.memoize(function ()
        util.haveGecko("2b")
            ? function (target, event, extra) {
                try {
                    this.feedingEvent = extra;
                    if (target instanceof Element)
                        // This causes a crash on Gecko<2.0, it seems.
                        (target.ownerDocument || target.document || target).defaultView
                               .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils)
                               .dispatchDOMEventViaPresShell(target, event, true);
                    else
                        target.dispatchEvent(event);
                }
                catch (e) {
                    util.reportError(e);
                }
                finally {
                    this.feedingEvent = null;
                }
            }
            : function (target, event, extra) target.dispatchEvent(event)),

    get defaultTarget() dactyl.focusedElement || content.document.body || document.documentElement,

    /**
     * Converts an event string into an array of pseudo-event objects.
     *
     * These objects can be used as arguments to events.toString or
     * events.create, though they are unlikely to be much use for other
     * purposes. They have many of the properties you'd expect to find on a
     * real event, but none of the methods.
     *
     * Also may contain two "special" parameters, .dactylString and
     * .dactylShift these are set for characters that can never by
     * typed, but may appear in mappings, for example <Nop> is passed as
     * dactylString, and dactylShift is set when a user specifies
     * <S-@> where @ is a non-case-changeable, non-space character.
     *
     * @param {string} keys The string to parse.
     * @returns {Array[Object]}
     */
    fromString: function (input, unknownOk) {
        let out = [];

        let re = RegExp("<.*?>?>|[^<]|<(?!.*>)", "g");
        let match;
        while ((match = re.exec(input))) {
            let evt_str = match[0];
            let evt_obj = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
                            keyCode: 0, charCode: 0, type: "keypress" };

            if (evt_str.length > 1) { // <.*?>
                let [match, modifier, keyname] = evt_str.match(/^<((?:[CSMA]-)*)(.+?)>$/i) || [false, '', ''];
                modifier = modifier.toUpperCase();
                keyname = keyname.toLowerCase();
                evt_obj.dactylKeyname = keyname;
                if (/^u[0-9a-f]+$/.test(keyname))
                    keyname = String.fromCharCode(parseInt(keyname.substr(1), 16));

                if (keyname && (unknownOk || keyname.length == 1 || /mouse$/.test(keyname) ||
                                this._key_code[keyname] || set.has(this._pseudoKeys, keyname))) {
                    evt_obj.ctrlKey  = /C-/.test(modifier);
                    evt_obj.altKey   = /A-/.test(modifier);
                    evt_obj.shiftKey = /S-/.test(modifier);
                    evt_obj.metaKey  = /M-/.test(modifier);

                    if (keyname.length == 1) { // normal characters
                        if (evt_obj.shiftKey) {
                            keyname = keyname.toUpperCase();
                            if (keyname == keyname.toLowerCase())
                                evt_obj.dactylShift = true;
                        }

                        evt_obj.charCode = keyname.charCodeAt(0);
                    }
                    else if (set.has(this._pseudoKeys)) {
                        evt_obj.dactylString = "<" + this._key_key[keyname] + ">";
                    }
                    else if (/mouse$/.test(keyname)) { // mouse events
                        evt_obj.type = (/2-/.test(modifier) ? "dblclick" : "click");
                        evt_obj.button = ["leftmouse", "middlemouse", "rightmouse"].indexOf(keyname);
                        delete evt_obj.keyCode;
                        delete evt_obj.charCode;
                    }
                    else { // spaces, control characters, and <
                        evt_obj.keyCode = this._key_code[keyname];
                        evt_obj.charCode = 0;
                    }
                }
                else { // an invalid sequence starting with <, treat as a literal
                    out = out.concat(events.fromString("<lt>" + evt_str.substr(1)));
                    continue;
                }
            }
            else // a simple key (no <...>)
                evt_obj.charCode = evt_str.charCodeAt(0);

            // TODO: make a list of characters that need keyCode and charCode somewhere
            if (evt_obj.keyCode == 32 || evt_obj.charCode == 32)
                evt_obj.charCode = evt_obj.keyCode = 32; // <Space>
            if (evt_obj.keyCode == 60 || evt_obj.charCode == 60)
                evt_obj.charCode = evt_obj.keyCode = 60; // <lt>

            evt_obj.modifiers = (evt_obj.ctrlKey && Ci.nsIDOMNSEvent.CONTROL_MASK)
                              | (evt_obj.altKey && Ci.nsIDOMNSEvent.ALT_MASK)
                              | (evt_obj.shiftKey && Ci.nsIDOMNSEvent.SHIFT_MASK)
                              | (evt_obj.metaKey && Ci.nsIDOMNSEvent.META_MASK);

            out.push(evt_obj);
        }
        return out;
    },

    /**
     * Converts the specified event to a string in dactyl key-code
     * notation. Returns null for an unknown event.
     *
     * @param {Event} event
     * @returns {string}
     */
    toString: function toString(event) {
        if (!event)
            return toString.supercall(this);

        if (event.dactylString)
            return event.dactylString;

        let key = null;
        let modifier = "";

        if (event.ctrlKey)
            modifier += "C-";
        if (event.altKey)
            modifier += "A-";
        if (event.metaKey)
            modifier += "M-";

        if (/^key/.test(event.type)) {
            let charCode = event.type == "keyup" ? 0 : event.charCode; // Why? --Kris
            if (charCode == 0) {
                if (event.keyCode in this._code_key) {
                    key = this._code_key[event.keyCode];

                    if (event.shiftKey && (key.length > 1 || event.ctrlKey || event.altKey || event.metaKey) || event.dactylShift)
                        modifier += "S-";
                    else if (!modifier && key.length === 1 && !event.shiftKey)
                        key = key.toLowerCase();
                    if (!modifier && /^[a-z0-9]$/i.test(key))
                        return key;
                }
            }
            // [Ctrl-Bug] special handling of mysterious <C-[>, <C-\\>, <C-]>, <C-^>, <C-_> bugs (OS/X)
            //            (i.e., cntrl codes 27--31)
            // ---
            // For more information, see:
            //     [*] Referenced mailing list msg: http://www.mozdev.org/pipermail/pentadactyl/2008-May/001548.html
            //     [*] Mozilla bug 416227: event.charCode in keypress handler has unexpected values on Mac for Ctrl with chars in "[ ] _ \"
            //         https://bugzilla.mozilla.org/show_bug.cgi?query_format=specific&order=relevance+desc&bug_status=__open__&id=416227
            //     [*] Mozilla bug 432951: Ctrl+'foo' doesn't seem same charCode as Meta+'foo' on Cocoa
            //         https://bugzilla.mozilla.org/show_bug.cgi?query_format=specific&order=relevance+desc&bug_status=__open__&id=432951
            // ---
            //
            // The following fixes are only activated if util.OS.isMacOSX.
            // Technically, they prevent mappings from <C-Esc> (and
            // <C-C-]> if your fancy keyboard permits such things<?>), but
            // these <C-control> mappings are probably pathological (<C-Esc>
            // certainly is on Windows), and so it is probably
            // harmless to remove the util.OS.isMacOSX if desired.
            //
            else if (util.OS.isMacOSX && event.ctrlKey && charCode >= 27 && charCode <= 31) {
                if (charCode == 27) { // [Ctrl-Bug 1/5] the <C-[> bug
                    key = "Esc";
                    modifier = modifier.replace("C-", "");
                }
                else // [Ctrl-Bug 2,3,4,5/5] the <C-\\>, <C-]>, <C-^>, <C-_> bugs
                    key = String.fromCharCode(charCode + 64);
            }
            // a normal key like a, b, c, 0, etc.
            else if (charCode > 0) {
                key = String.fromCharCode(charCode);

                if (!/^[a-z0-9]$/i.test(key) && key in this._key_code) {
                    // a named charCode key (<Space> and <lt>) space can be shifted, <lt> must be forced
                    if ((key.match(/^\s$/) && event.shiftKey) || event.dactylShift)
                        modifier += "S-";

                    key = this._code_key[this._key_code[key]];
                }
                else {
                    // a shift modifier is only allowed if the key is alphabetical and used in a C-A-M- mapping in the uppercase,
                    // or if the shift has been forced for a non-alphabetical character by the user while :map-ping
                    if (key != key.toLowerCase() && (event.ctrlKey || event.altKey || event.metaKey) || event.dactylShift)
                        modifier += "S-";
                    if (/^\s$/.test(key))
                        key = let (s = charCode.toString(16)) "U" + "0000".substr(4 - s.length) + s;
                    else if (modifier.length == 0)
                        return key;
                }
            }
            if (key == null)
                key = this._key_key[event.dactylKeyname] || event.dactylKeyname;
            if (key == null)
                return null;
        }
        else if (event.type == "click" || event.type == "dblclick") {
            if (event.shiftKey)
                modifier += "S-";
            if (event.type == "dblclick")
                modifier += "2-";
            // TODO: triple and quadruple click

            switch (event.button) {
            case 0:
                key = "LeftMouse";
                break;
            case 1:
                key = "MiddleMouse";
                break;
            case 2:
                key = "RightMouse";
                break;
            }
        }

        if (key == null)
            return null;

        return "<" + modifier + key + ">";
    },

    /**
     * Whether *key* is a key code defined to accept/execute input on the
     * command line.
     *
     * @param {string} key The key code to test.
     * @returns {boolean}
     */
    isAcceptKey: function (key) key == "<Return>" || key == "<C-j>" || key == "<C-m>",

    /**
     * Whether *key* is a key code defined to reject/cancel input on the
     * command line.
     *
     * @param {string} key The key code to test.
     * @returns {boolean}
     */
    isCancelKey: function (key) key == "<Esc>" || key == "<C-[>" || key == "<C-c>",

    isContentNode: function isContentNode(node) {
        let win = (node.ownerDocument || node).defaultView || node;
        for (; win; win = win.parent != win && win.parent)
            if (win == content)
                return true;
        return false;
    },

    /**
     * Waits for the current buffer to successfully finish loading. Returns
     * true for a successful page load otherwise false.
     *
     * @returns {boolean}
     */
    waitForPageLoad: function () {
        util.threadYield(true); // clear queue

        if (buffer.loaded == 1)
            return true;

        const maxWaitTime = 25;
        let start = Date.now();
        let end = start + (maxWaitTime * 1000); // maximum time to wait - TODO: add option
        let now;
        while (now = Date.now(), now < end) {
            util.threadYield();

            if (!events.feedingKeys)
                return false;

            if (buffer.loaded > 0) {
                util.sleep(250);
                break;
            }
            else
                dactyl.echo("Waiting for page to load...", commandline.DISALLOW_MULTILINE);
        }
        commandline.clear();

        // TODO: allow macros to be continued when page does not fully load with an option
        if (!buffer.loaded)
            dactyl.echoerr("Page did not load completely in " + maxWaitTime + " seconds. Macro stopped.");

        // sometimes the input widget had focus when replaying a macro
        // maybe this call should be moved somewhere else?
        // dactyl.focusContent(true);

        return buffer.loaded;
    },

    onDOMMenuBarActive: function () {
        this._activeMenubar = true;
        modes.add(modes.MENU);
    },

    onDOMMenuBarInactive: function () {
        this._activeMenubar = false;
        modes.remove(modes.MENU);
    },

    /**
     * Ensures that the currently focused element is visible and blurs
     * it if it's not.
     */
    checkFocus: function () {
        if (dactyl.focusedElement) {
            let rect = dactyl.focusedElement.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                services.focus.clearFocus(window);
                document.commandDispatcher.focusedWindow = content;
                // onFocusChange needs to die.
                this.onFocusChange();
            }
        }
    },

    onBlur: function onFocus(event) {
        if (event.originalTarget instanceof Window && services.focus.activeWindow == null) {
            // Deals with circumstances where, after the main window
            // blurs while a collapsed frame has focus, re-activating
            // the main window does not restore focus and we lose key
            // input.
            services.focus.clearFocus(window);
            document.commandDispatcher.focusedWindow = content;
        }
    },

    // TODO: Merge with onFocusChange
    onFocus: function onFocus(event) {
        let elem = event.originalTarget;
        if (elem instanceof Element) {
            let win = elem.ownerDocument.defaultView;

            if (event.target instanceof Ci.nsIDOMXULTextBoxElement)
                for (let e = elem; e; e = e.parentNode)
                    if (util.computedStyle(e).visibility !== "visible") {
                        elem.blur();
                        break;
                    }

            if (events.isContentNode(elem) && !buffer.focusAllowed(elem)
                && !(services.focus.getLastFocusMethod(win) & 0x7000)
                && isinstance(elem, [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, Window])) {
                if (elem.frameElement)
                    dactyl.focusContent(true);
                else if (!(elem instanceof Window) || Editor.getEditor(elem))
                    elem.blur();
            }
        }
    },

    /*
    onFocus: function onFocus(event) {
        let elem = event.originalTarget;
        if (!(elem instanceof Element))
            return;
        let win = elem.ownerDocument.defaultView;

        try {
            util.dump(elem, services.focus.getLastFocusMethod(win) & (0x7000));
            if (buffer.focusAllowed(win))
                win.dactylLastFocus = elem;
            else if (isinstance(elem, [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement])) {
                if (win.dactylLastFocus)
                    dactyl.focus(win.dactylLastFocus);
                else
                    elem.blur();
            }
        }
        catch (e) {
            util.dump(win, String(elem.ownerDocument), String(elem.ownerDocument && elem.ownerDocument.defaultView));
            util.reportError(e);
        }
    },
    */

    // argument "event" is deliberately not used, as i don't seem to have
    // access to the real focus target
    // Huh? --djk
    onFocusChange: function onFocusChange(event) {
        // command line has its own focus change handler
        if (modes.main == modes.COMMAND_LINE)
            return;

        function hasHTMLDocument(win) win && win.document && win.document instanceof HTMLDocument

        let win  = window.document.commandDispatcher.focusedWindow;
        let elem = window.document.commandDispatcher.focusedElement;

        if (elem == null && Editor.getEditor(win))
            elem = win;

        if (win && win.top == content && dactyl.has("tabs"))
            buffer.focusedFrame = win;

        try {
            if (elem && elem.readOnly)
                return;

            if (isinstance(elem, [HTMLEmbedElement, HTMLEmbedElement])) {
                modes.push(modes.EMBED);
                return;
            }

            if (Events.isInputElement(elem)) {
                if (!(modes.main & (modes.INSERT | modes.TEXT_EDIT | modes.VISUAL)))
                    modes.push(modes.INSERT);

                if (hasHTMLDocument(win))
                    buffer.lastInputField = elem;
                return;
            }

            if (elem instanceof HTMLTextAreaElement || (elem && util.computedStyle(elem).MozUserModify == "read-write")
               || elem == null && win && Editor.getEditor(win)) {

                if (modes.main == modes.VISUAL && elem.selectionEnd == elem.selectionStart)
                    modes.pop();

                if (!(modes.main & (modes.INSERT | modes.TEXT_EDIT | modes.VISUAL)))
                    if (options["insertmode"])
                        modes.push(modes.INSERT);
                    else {
                        modes.push(modes.TEXT_EDIT);
                        if (elem.selectionEnd - elem.selectionStart > 0)
                            modes.push(modes.VISUAL);
                    }

                if (hasHTMLDocument(win))
                    buffer.lastInputField = elem;
                return;
            }

            if (config.focusChange) {
                config.focusChange(win);
                return;
            }

            let urlbar = document.getElementById("urlbar");
            if (elem == null && urlbar && urlbar.inputField == this._lastFocus)
                util.threadYield(true);

            while (modes.main.ownsFocus)
                 modes.pop(null, { fromFocus: true });
        }
        finally {
            this._lastFocus = elem;
        }
    },

    // this keypress handler gets always called first, even if e.g.
    // the command-line has focus
    // TODO: ...help me...please...
    onKeyPress: function onKeyPress(event) {
        event.dactylDefaultPrevented = event.getPreventDefault();

        function kill(event) {
            event.preventDefault();
            event.stopPropagation();
        }

        function shouldPass()
            (!dactyl.focusedElement || events.isContentNode(dactyl.focusedElement)) &&
            options.get("passkeys").has(events.toString(event));

        let duringFeed = this.duringFeed || [];
        this.duringFeed = [];
        try {
            if (this.feedingEvent && [!(k in event) || event[k] === v for ([k, v] in Iterator(this.feedingEvent))].every(util.identity)) {
                for (let [k, v] in Iterator(this.feedingEvent))
                    if (!(k in event))
                        event[k] = v;
                this.feedingEvent = null;
            }

            let key = events.toString(event);
            if (!key)
                 return null;

            if (modes.recording && (!this._input || !mappings.user.hasMap(modes.main, this._input.buffer + key)))
                events._macroKeys.push(key);

            // feedingKeys needs to be separate from interrupted so
            // we can differentiate between a recorded <C-c>
            // interrupting whatever it's started and a real <C-c>
            // interrupting our playback.
            if (events.feedingKeys && !event.isMacro) {
                if (!event.originalTarget)
                    util.dumpStack();
                if (key == "<C-c>") {
                    events.feedingKeys = false;
                    if (modes.replaying) {
                        modes.replaying = false;
                        this.timeout(function () { dactyl.echomsg("Canceled playback of macro '" + this._lastMacro + "'"); }, 100);
                    }
                }
                else
                    duringFeed.push(event);

                return kill(event);
            }

            let mode = modes.getStack(0);
            if (event.dactylMode)
                mode = Modes.StackElement(event.dactylMode);

            let processors = this._processors;
            this._processors = [];
            if (!processors.length) {
                let ignore = false;
                let overrideMode = null;

                // menus have their own command handlers
                if (modes.extended & modes.MENU)
                    overrideMode = modes.MENU;

                if (modes.main == modes.PASS_THROUGH)
                    ignore = !Events.isEscape(key) && key != "<C-v>";
                else if (modes.main == modes.QUOTE) {
                    if (modes.getStack(1).main == modes.PASS_THROUGH) {
                        mode.params.mainMode = modes.getStack(2).main;
                        ignore = Events.isEscape(key);
                    }
                    else if (shouldPass())
                        mode.params.mainMode = modes.getStack(1).main;
                    else
                        ignore = true;

                    if (ignore && !Events.isEscape(key))
                        modes.pop();
                }
                else if (!event.isMacro && !event.noremap && shouldPass())
                    ignore = true;

                if (ignore)
                    return null;

                if (key == "<C-c>")
                    util.interrupted = true;

                if (config.ignoreKeys[key] & mode.main)
                    return null;

                if (overrideMode)
                    var keyModes = array([overrideMode]);
                else
                    keyModes = array([mode.params.keyModes, mode.main, mode.main.allBases]).flatten().compact();

                let hives = mappings.hives.slice(event.noremap ? -1 : 0);

                processors = keyModes.map(function (m) hives.map(function (h) Events.KeyProcessor(m, h)))
                                     .flatten().array;

                for (let [i, input] in Iterator(processors)) {
                    let params = input.main == mode.main ? mode.params : input.main.params;
                    if (params.preExecute)
                        input.preExecute = params.preExecute;
                    if (params.postExecute)
                        input.postExecute = params.postExecute;
                    if (params.onEvent && input.hive === mappings.builtin)
                        input.fallthrough = function (event) {
                            return params.onEvent(event) === false ? Events.KILL : Events.PASS;
                        };
                    }
            }

            let refeed, buffer, waiting = 0;
            for (let input in values(processors)) {
                var res = input.process(event);
                waiting += res == Events.WAIT;
                buffer = buffer || input.inputBuffer;

                if (isArray(res) && !waiting)
                    refeed = res;
                if (res === Events.KILL)
                    break;
            }

            if (!refeed || refeed.length == 1)
                for (let input in values(processors))
                    if (input.fallthrough) {
                        if (res === Events.KILL)
                            break;
                        res = dactyl.trapErrors(input.fallthrough, input, event);
                    }

            if (!processors.some(function (p) p.main.ownsBuffer))
                statusline.updateInputBuffer(buffer);

            if (waiting) {
                res = Events.KILL;
                this._processors = processors;
            }
            if (res !== Events.KILL && (mode.main & (modes.TEXT_EDIT | modes.VISUAL))) {
                res = Events.KILL;
                dactyl.beep();
            }

            if (res !== Events.PASS && !isArray(res))
                refeed = null;

            if (refeed && refeed[0] && (!refeed[0].getPreventDefault() || refeed[0].dactylDefaultPrevented)) {
                res = Events.PASS;
                refeed.shift();
            }

            if (res !== Events.PASS)
                kill(event);

            if (refeed)
                for (let [i, event] in Iterator(refeed))
                    if (event.originalTarget) {
                        let evt = events.create(event.originalTarget.ownerDocument, event.type, event);
                        events.dispatch(event.originalTarget, evt, { skipmap: true, isMacro: true });
                    }
                    else if (i > 0)
                        events.onKeyPress(event);
        }
        catch (e) {
            dactyl.reportError(e);
        }
        finally {
            [duringFeed, this.duringFeed] = [this.duringFeed, duringFeed];
            if (this.feedingKeys)
                this.duringFeed = this.duringFeed.concat(duringFeed);
            else
                for (let event in values(duringFeed))
                    try {
                        this.dispatch(event.originalTarget, event, event);
                    }
                    catch (e) {
                        util.reportError(e);
                    }
        }
    },

    onKeyUpOrDown: function onKeyUpOrDown(event) {
        // Prevent certain sites from transferring focus to an input box
        // before we get a chance to process our key bindings on the
        // "keypress" event.

        function shouldPass() // FIXME.
            (!dactyl.focusedElement || events.isContentNode(dactyl.focusedElement)) &&
            options.get("passkeys").has(events.toString(event));

        if (modes.main == modes.PASS_THROUGH ||
            modes.main == modes.QUOTE
                && modes.getStack(1).main !== modes.PASS_THROUGH
                && !shouldPass() ||
            !modes.passThrough && shouldPass())
            return;

        if (!Events.isInputElement(dactyl.focusedElement))
            event.stopPropagation();
    },

    onMouseDown: function onMouseDown(event) {
        let elem = event.target;
        let win = elem.ownerDocument && elem.ownerDocument.defaultView || elem;

        for (; win; win = win != win.parent && win.parent)
            win.document.dactylFocusAllowed = true;
    },

    onPopupShown: function onPopupShown(event) {
        if (event.originalTarget.localName !== "tooltip" && event.originalTarget.id !== "dactyl-visualbell")
            modes.add(modes.MENU);
    },

    onPopupHidden: function onPopupHidden() {
        // gContextMenu is set to NULL, when a context menu is closed
        if (window.gContextMenu == null && !this._activeMenubar)
            modes.remove(modes.MENU);
    },

    onResize: function onResize(event) {
        if (window.fullScreen != this._fullscreen) {
            statusline.statusBar.removeAttribute("moz-collapsed");
            this._fullscreen = window.fullScreen;
            dactyl.triggerObserver("fullscreen", this._fullscreen);
            autocommands.trigger("Fullscreen", { url: this._fullscreen ? "on" : "off", state: this._fullscreen });
        }
    },

    onSelectionChange: function onSelectionChange(event) {
        let controller = document.commandDispatcher.getControllerForCommand("cmd_copy");
        let couldCopy = controller && controller.isCommandEnabled("cmd_copy");

        if (modes.main == modes.VISUAL) {
            if (!couldCopy)
                modes.pop(); // Really not ideal.
        }
        else if (couldCopy) {
            if (modes.main == modes.TEXT_EDIT && !options["insertmode"])
                modes.push(modes.VISUAL);
            else if (modes.main == modes.CARET)
                modes.push(modes.VISUAL);
        }
    }
}, {
    KILL: true,
    PASS: false,
    WAIT: null,


    KeyProcessor: Class("KeyProcessor", {
        init: function init(main, hive) {
            this.main = main;
            this.events = [];
            this.hive = hive;
        },

        get toStringParams() [this.main.name, this.hive.name],

        buffer: "",             // partial command storage
        pendingMotionMap: null, // e.g. "d{motion}" if we wait for a motion of the "d" command
        pendingArgMap: null,    // pending map storage for commands like m{a-z}
        count: null,            // parsed count from the input buffer
        motionCount: null,

        append: function append(event) {
            this.events.push(event);
            this.buffer += events.toString(event);
            return this.events;
        },

        process: function process(event) {
            function kill(event) {
                event.stopPropagation();
                event.preventDefault();
            }

            let res = this.onKeyPress(event);
            if (res === Events.KILL)
                kill(event);

            if (res != Events.WAIT)
                this.inputBuffer = "";
            else {
                let motionMap = (this.pendingMotionMap && this.pendingMotionMap.names[0]) || "";
                this.inputBuffer = motionMap + this.buffer;
            }

            return res;
        },

        onKeyPress: function onKeyPress(event) {
            // This all needs to go. It's horrible. --Kris

            const self = this;

            let key = events.toString(event);
            let [, countStr, command] = /^((?:[1-9][0-9]*)?)(.*)/.exec(this.buffer + key);

            var map = this.hive.get(this.main, command);

            function execute(map) {
                if (self.preExecute)
                    self.preExecute.apply(self, arguments);
                let res = map.execute.apply(map, Array.slice(arguments, 1));
                if (self.postExecute) // To do: get rid of this.
                    self.postExecute.apply(self, arguments);
                return res;
            }

            let candidates = this.hive.getCandidates(this.main, command);
            if (candidates == 0 && !map) {
                [map] = this.pendingMap || [];
                this.pendingMap = null;
                if (map && map.arg)
                    this.pendingArgMap = [map, command];
            }

            // counts must be at the start of a complete mapping (10j -> go 10 lines down)
            if (countStr && !command) {
                // no count for insert mode mappings
                if (!this.main.count)
                    return this.append(event);
                else if (this.main.input)
                    return Events.PASS;
                else
                    this.append(event);
            }
            else if (this.pendingArgMap) {
                let [map, command] = this.pendingArgMap;
                if (!Events.isEscape(key))
                    execute(map, null, this.count, key, command);
                return Events.KILL;
            }
            else if (!event.skipmap && map && candidates == 0) {
                this.pendingMap = null;

                let count = this.pendingMotionMap ? "motionCount" : "count";
                this[count] = parseInt(countStr, 10);

                if (isNaN(this[count]))
                    this[count] = null;

                if (map.arg) {
                    this.append(event);
                    this.pendingArgMap = [map, command];
                }
                else if (this.pendingMotionMap) {
                    let [map, command] = this.pendingMotionMap;
                    if (!Events.isEscape(key))
                        execute(map, command, this.motionCount || this.count, null, command);
                    return Events.KILL;
                }
                else if (map.motion) {
                    this.buffer = "";
                    this.pendingMotionMap = [map, command];
                }
                else {
                    if (modes.replaying && !events.waitForPageLoad())
                        return Events.KILL;

                    return execute(map, null, this.count, null, command) === Events.PASS ? Events.PASS : Events.KILL;
                }
            }
            else if (!event.skipmap && this.hive.getCandidates(this.main, command) > 0) {
                this.append(event);
                this.pendingMap = [map, command];
            }
            else {
                this.append(event);
                return this.events;
            }
            return Events.WAIT;
        }
    }),

    isEscape: function isEscape(event)
        let (key = isString(event) ? event : events.toString(event))
            key === "<Esc>" || key === "<C-[>",

    isInputElement: function isInputElement(elem) {
        return elem instanceof HTMLInputElement && set.has(util.editableInputs, elem.type) ||
               isinstance(elem, [HTMLIsIndexElement, HTMLEmbedElement,
                                 HTMLObjectElement, HTMLSelectElement,
                                 HTMLTextAreaElement,
                                 Ci.nsIDOMXULTreeElement, Ci.nsIDOMXULTextBoxElement]) ||
               elem instanceof Window && Editor.getEditor(elem);
    }
}, {
    commands: function () {
        commands.add(["delmac[ros]"],
            "Delete macros",
            function (args) {
                dactyl.assert(!args.bang || !args[0], "E474: Invalid argument");

                if (args.bang)
                    events.deleteMacros();
                else if (args[0])
                    events.deleteMacros(args[0]);
                else
                    dactyl.echoerr("E471: Argument required");
            }, {
                bang: true,
                completer: function (context) completion.macro(context),
                literal: 0
            });

        commands.add(["macros"],
            "List all macros",
            function (args) { completion.listCompleter("macro", args[0]); }, {
                argCount: "?",
                completer: function (context) completion.macro(context)
            });
    },
    completion: function () {
        completion.macro = function macro(context) {
            context.title = ["Macro", "Keys"];
            context.completions = [item for (item in events.getMacros())];
        };
    },
    mappings: function () {
        mappings.add(modes.all,
            ["<C-z>"], "Temporarily ignore all " + config.appName + " key bindings",
            function () { modes.push(modes.PASS_THROUGH); });

        mappings.add(modes.all,
            ["<C-v>"], "Pass through next key",
            function () {
                if (modes.main == modes.QUOTE)
                    return Events.PASS;
                modes.push(modes.QUOTE);
            });

        mappings.add(modes.all,
            ["<Nop>"], "Do nothing",
            function () {});

        // macros
        mappings.add([modes.NORMAL, modes.TEXT_AREA, modes.PLAYER].filter(util.identity),
            ["q"], "Record a key sequence into a macro",
            function ({ arg }) {
                events._macroKeys.pop();
                events[modes.recording ? "finishRecording" : "startRecording"](arg);
            },
            { get arg() !modes.recording });

        mappings.add([modes.NORMAL, modes.TEXT_AREA, modes.PLAYER].filter(util.identity),
            ["@"], "Play a macro",
            function ({ arg, count }) {
                count = Math.max(count, 1);
                while (count-- && events.playMacro(arg))
                    ;
            },
            { arg: true, count: true });
    },
    options: function () {
        options.add(["passkeys", "pk"],
            "Pass certain keys through directly for the given URLs",
            "regexpmap", "", {
                has: function (key) {
                    let url = buffer.documentURI.spec;
                    for (let re in values(this.value))
                        if (re.test(url) && re.result.some(function (k) k === key))
                            return true;
                    return false;
                },
                setter: function (values) {
                    values.forEach(function (re) {
                        re.result = events.fromString(re.result).map(events.closure.toString);
                        re.result.toString = function toString() this.join("");
                    });
                    return values;
                }
            });
        options.add(["strictfocus", "sf"],
            "Prevent scripts from focusing input elements without user intervention",
            "boolean", true);
    },
    sanitizer: function () {
        sanitizer.addItem("macros", {
            description: "Saved macros",
            persistent: true,
            action: function (timespan, host) {
                if (!host)
                    for (let [k, m] in events._macros)
                        if (timespan.contains(m.timeRecorded * 1000))
                            events._macros.remove(k);
            }
        });
    }
});

// vim: set fdm=marker sw=4 ts=4 et:
