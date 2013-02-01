/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, brackets, $ */

define(function (require, exports, module) {
    "use strict";

    var CodeHintManager         = brackets.getModule("editor/CodeHintManager"),
        EditorManager           = brackets.getModule("editor/EditorManager"),
        AppInit                 = brackets.getModule("utils/AppInit"),
        StringUtils             = brackets.getModule("utils/StringUtils"),
        HintUtils               = require("HintUtils"),
        ScopeManager            = require("ScopeManager"),
        Session                 = require("Session").Session,
        usage                   = require("usage");

    var session             = null,  // object that encapsulates the current session state
        cachedHints         = null,  // sorted hints for the current hinting session
        cachedType          = null,  // describes the lookup type and the object context
        cachedScope         = null,  // the inner-most scope returned by the query worker
        cachedLine          = null,  // the line number for the cached scope
        $deferredHints      = null,  // deferred hint object
        $deferredScope      = null;  // deferred scope object

    /**
     * Creates a hint response object
     */
    function getResponse(hints, query) {

        var trimmedQuery,
            filteredHints,
            formattedHints;

        /*
         * Filter a list of tokens using a given query string
         */
        function filterWithQuery(tokens) {
            // If the query is a string literal (i.e., if it starts with a
            // string literal delimiter, and hence if trimmedQuery !== query)
            // then only string literal hints should be returned, and matching
            // should be performed w.r.t. trimmedQuery. If the query is 
            // otherwise non-empty, no string literals should match. If the
            // query is empty then no hints are filtered.
            if (trimmedQuery !== query) {
                return tokens.filter(function (token) {
                    if (token.literal && token.kind === "string") {
                        return (token.value.indexOf(trimmedQuery) === 0);
                    } else {
                        return false;
                    }
                });
            } else if (query.length > 0) {
                return tokens.filter(function (token) {
                    if (token.literal && token.kind === "string") {
                        return false;
                    } else {
                        return (token.value.indexOf(query) === 0);
                    }
                });
            } else {
                return tokens;
            }
        }

        /*
         * Returns a formatted list of hints with the query substring highlighted
         */
        function formatHints(hints, query) {
            return hints.map(function (token) {
                var hint        = token.value,
                    index       = hint.indexOf(query),
                    $hintObj    = $('<span>'),
                    delimiter   = "";

                // level indicates either variable scope or property confidence
                switch (token.level) {
                case 0:
                    $hintObj.css('color', 'rgb(0,100,0)'); // green
                    break;
                case 1:
                    $hintObj.css('color', 'rgb(100,100,0)'); // yellow
                    break;
                case 2:
                    $hintObj.css('color', 'rgb(0,0,100)'); // blue
                    break;
                }

                // is the token a global variable?
                if (token.global) {
                    $hintObj.css('font-style', 'italic');
                }
                
                // is the token a literal?
                if (token.literal) {
                    $hintObj.css('color', 'rgb(50,50,50)'); // grey
                    if (token.kind === "string") {
                        delimiter = HintUtils.DOUBLE_QUOTE;
                    }
                }
                
                // is the token a keyword?
                if (token.keyword) {
                    $hintObj.css('font-family', 'monospace');
                }
             
                // higlight the matched portion of each hint
                if (index >= 0) {
                    var prefix  = StringUtils.htmlEscape(hint.slice(0, index)),
                        match   = StringUtils.htmlEscape(hint.slice(index, index + query.length)),
                        suffix  = StringUtils.htmlEscape(hint.slice(index + query.length));

                    $hintObj.append(delimiter + prefix)
                        .append($('<span>')
                                .append(match)
                                .css('font-weight', 'bold'))
                        .append(suffix + delimiter);
                } else {
                    $hintObj.text(delimiter + hint + delimiter);
                }
                $hintObj.data('token', token);
                
                return $hintObj;
            });
        }
        
        // trim leading and trailing string literal delimiters from the query
        if (query.indexOf(HintUtils.SINGLE_QUOTE) === 0 ||
                query.indexOf(HintUtils.DOUBLE_QUOTE) === 0) {
            trimmedQuery = query.substring(1);
            if (trimmedQuery.lastIndexOf(HintUtils.DOUBLE_QUOTE) === trimmedQuery.length - 1 ||
                    trimmedQuery.lastIndexOf(HintUtils.SINGLE_QUOTE) === trimmedQuery.length - 1) {
                trimmedQuery = trimmedQuery.substring(0, trimmedQuery.length - 1);
            }
        } else {
            trimmedQuery = query;
        }

        filteredHints = filterWithQuery(hints).slice(0, 100);
        formattedHints = formatHints(filteredHints, trimmedQuery);

        return {
            hints: formattedHints,
            match: null, // the CodeHintManager should not format the results
            selectInitial: true
        };
    }

    /**
     * @constructor
     */
    function JSHints() {
    }

    /**
     * Determine whether hints are available for a given editor context
     */
    JSHints.prototype.hasHints = function (editor, key) {
        
        /*
         * Resolve deferred hints upon resolution of a deferred scope
         */
        function handleScope(scopeInfo) {
            var query   = session.getQuery(),
                response;
    
            session.setScopeInfo(scopeInfo);
            cachedScope = scopeInfo.scope;
            cachedLine = session.getCursor().line;
            cachedType = session.getType();
            cachedHints = session.getHints();
            
            if ($deferredHints && $deferredHints.state() === "pending") {
                response = getResponse(cachedHints, query);
                $deferredHints.resolveWith(null, [response]);
            }
        }

        $(this).triggerHandler("hasHints");

        if ((key === null) || HintUtils.maybeIdentifier(key)) {
            var token = session.getCurrentToken();

            // don't autocomplete within strings or comments, etc.
            if (token && HintUtils.hintable(token)) {
                var path        = session.getPath(),
                    offset      = session.getOffset(),
                    line        = session.getCursor().line,
                    scopeInfo;
                
                $(this).triggerHandler("beginHintSession", [key]);
                
                // Try to get a new scope if: 1) none exists; 2) the cursor has 
                // moved more than a single line; 3) the scope is dirty; or 4)
                // if the cursor has moved into a different scope.
                if (!cachedScope ||
                        Math.abs(line - cachedLine) > 1 ||
                        ScopeManager.isScopeDirty(path, offset, cachedScope) ||
                        !cachedScope.containsPositionImmediate(offset)) {
                    scopeInfo = ScopeManager.getScope(path, offset);
                    cachedHints = null;
                    
                    // If the scope is deferred, deferred hints will have to
                    // be returned as well. Otherwise, update the session with
                    // the new scope information.
                    if (scopeInfo.hasOwnProperty("deferred")) {
                        cachedScope = null;
                        cachedLine = null;
                        
                        $deferredScope = scopeInfo.deferred;
                        $deferredScope.done(handleScope);
                    } else {
                        cachedScope = scopeInfo.scope;
                        cachedLine = session.getCursor().line;
                        session.setScopeInfo(scopeInfo);
                        
                        if ($deferredScope) {
                            if ($deferredScope.state() === "pending") {
                                $deferredScope.reject();
                            }
                            $deferredScope = null;
                        }
                    }
                }

                return true;
            }
        }
        return false;
    };

    /** 
      * Return a list of hints, possibly deferred, for the current editor 
      * context
      */
    JSHints.prototype.getHints = function (key) {
        var token = session.getCurrentToken();
        if ((key === null) || HintUtils.maybeIdentifier(token.string)) {
            if (token && HintUtils.hintable(token)) {
                if (cachedScope) {
                    var type    = session.getType(),
                        query   = session.getQuery();

                    // Compute fresh hints if none exist, or if the session
                    // type has changed since the last hint computation
                    if (!cachedHints ||
                            type.property !== cachedType.property ||
                            type.context !== cachedType.context) {
                        cachedType = type;
                        cachedHints = session.getHints();
                        $(this).triggerHandler("refreshHints", [key, cachedHints, cachedType]);
                    }
                    
                    $(this).triggerHandler("hintResponse", [query]);
                    return getResponse(cachedHints, query);
                } else if ($deferredScope && $deferredScope.state() === "pending") {
                    // If there is no cached scope object, we cannot return hints.
                    // Instead, return a deferred response that will be resolved 
                    // when a scope is received.
                    if (!$deferredHints || $deferredHints.isRejected()) {
                        $deferredHints = $.Deferred();
                    }
                    $(this).triggerHandler("deferredResponse");
                    return $deferredHints;
                }
            }
        }

        $(this).triggerHandler("nullResponse");
        return null;
    };

    /**
     * Enters the code completion text into the editor
     * 
     * @param {string} hint - text to insert into current code editor
     */
    JSHints.prototype.insertHint = function ($hintObj) {
        var hint        = $hintObj.data('token'),
            completion  = hint.value,
            cursor      = session.getCursor(),
            token       = session.getCurrentToken(),
            query       = session.getQuery(),
            start       = {line: cursor.line, ch: cursor.ch - query.length},
            end         = {line: cursor.line, ch: (token ? token.end : cursor.ch)},
            delimeter;

        $(this).triggerHandler("insertHint", [completion]);

        // If the hint is a string literal, choose a delimiter in which
        // to wrap it, preserving the existing delimiter if possible.
        if (hint.literal && hint.kind === "string") {
            if (token.string.indexOf(HintUtils.DOUBLE_QUOTE) === 0) {
                delimeter = HintUtils.DOUBLE_QUOTE;
            } else if (token.string.indexOf(HintUtils.SINGLE_QUOTE) === 0) {
                delimeter = HintUtils.SINGLE_QUOTE;
            } else {
                delimeter = hint.delimeter;
            }

            completion = delimeter +
                completion.replace(delimeter, "\\" + delimeter) +
                delimeter;
        }

        // Replace the current token with the completion
        session.editor._codeMirror.replaceRange(completion, start, end);

        // Return false to indicate that another hinting session is not needed
        return false;
    };


    // load the extension
    AppInit.appReady(function () {

        /*
         * When the editor is changed, reset the hinting session and cached 
         * information, and reject any pending deferred requests.
         */
        function handleEditorChange(editor) {
            ScopeManager.handleEditorChange(editor.document.file.fullPath);
            session = new Session(editor);
            cachedScope = null;
            cachedLine = null;
            cachedHints = null;
            cachedType = null;
            
            if ($deferredHints) {
                if ($deferredHints.state() === "pending") {
                    $deferredHints.reject();
                }
                $deferredHints = null;
            }
            
            if ($deferredScope) {
                if ($deferredScope.state() === "pending") {
                    $deferredScope.reject();
                }
                $deferredScope = null;
            }
        }

        /*
         * Install editor change listeners
         */
        function installEditorListeners(editor) {
            if (!editor) {
                return;
            }

            var path = editor.document.file.fullPath;

            if (editor.getModeForSelection() === HintUtils.MODE_NAME) {
                handleEditorChange(editor);
                $(editor)
                    .on(HintUtils.eventName("change"), function () {
                        ScopeManager.handleFileChange(path);
                    });
            }
        }

        /*
         * Uninstall editor change listeners
         */
        function uninstallEditorListeners(editor) {
            $(editor)
                .off(HintUtils.eventName("change"));
        }

        // uninstall/install change listener as the active editor changes
        $(EditorManager)
            .on(HintUtils.eventName("activeEditorChange"),
                function (event, current, previous) {
                    uninstallEditorListeners(previous);
                    installEditorListeners(current);
                });
        
        // immediately install the current editor
        installEditorListeners(EditorManager.getActiveEditor());

        var jsHints = new JSHints();
        CodeHintManager.registerHintProvider(jsHints, [HintUtils.MODE_NAME], 0);
            
        usage.listen(jsHints);

        // for unit testing
        exports.jsHintProvider = jsHints;
        exports.handleEditorChange = handleEditorChange;
    });
});
