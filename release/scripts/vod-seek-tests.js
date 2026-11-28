/* VOD seeking with the D-pad (#52): Left/Right seeks from the Pause row too, rapid taps grow the
 * step like a held key, the burst ends on the executed seek or after a pause, and the step growth
 * can never index past the step table (vod_seek_max default 11 points past its last index).
 * Extracts the real keydown/seek functions from PlayVod.js and drives them on a fake clock. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const UglifyJS = require('uglify-js');

const NAMES = /^PlayVod_(handleKeyDown|FastBackForward|jumpStart|jumpSteps|SizeClear|jump)$/;
const definitions = [];

if (process.argv.includes('--built')) {
    const ast = UglifyJS.parse(fs.readFileSync('release/githubio/js/main_uncompressed.js', 'utf8'));
    ast.walk(
        new UglifyJS.TreeWalker(node => {
            if (node instanceof UglifyJS.AST_Defun && NAMES.test(node.name.name)) definitions.push(node.print_to_string());
        })
    );
    if (definitions.length < 6) throw new Error('Rebuild first: PlayVod seek definitions missing from generated source');
} else {
    const ast = UglifyJS.parse(fs.readFileSync('app/specific/PlayVod.js', 'utf8'));
    ast.walk(
        new UglifyJS.TreeWalker(node => {
            if (node instanceof UglifyJS.AST_Defun && NAMES.test(node.name.name)) definitions.push(node.print_to_string());
        })
    );
    if (definitions.length < 6) throw new Error('PlayVod seek definitions missing from app source');
}

const Settings_jumpTimers = [5, 10, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600];
const Settings_Seek_Time = [250, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

let now = 100000; //fake clock, never zero: jumpStart seeds OldTime with getTime()
const timers = new Map(); //id -> {fn, at}
let panelShowing = true;
const focusCalls = [],
    iconNavCalls = [],
    seekCalls = [],
    showPanelCalls = [],
    playerUIShowCalls = [];

function element() {
    return {style: {}};
}

const s = {
    console,
    Math,
    KEY_LEFT: 37,
    KEY_UP: 38,
    KEY_RIGHT: 39,
    KEY_DOWN: 40,
    KEY_ENTER: 13,
    //player state: a 1h VOD, 10 minutes in
    PlayVod_isOn: true,
    Play_isOn: true,
    PlayClip_isOn: false,
    PlayClip_HasVOD: false,
    PlayVod_IsJumping: false,
    PlayVod_PanelY: 0,
    PlayVod_ProgressBaroffset: 0,
    PlayVod_addToJump: 0,
    PlayVod_TimeToJump: 0,
    PlayVod_OldTime: 0,
    PlayVod_jumpCount: 1,
    PlayVod_jump_max_step: 11, //Settings default, one past the last table index
    PlayVod_jumpStepsIncreaseLock: false,
    PlayVod_last_multiplier: '',
    PlayVod_SizeClearID: undefined,
    Play_DefaultjumpTimers: Settings_jumpTimers,
    Play_DurationSeconds: 3600,
    Play_BufferSize: 60,
    Play_OpenRewind: false,
    Play_ProgresBarrElm: element(),
    Play_BottonIcons_Progress_Steps: element(),
    Play_BottonIcons_Pause: element(),
    Settings_value: {
        vod_seek_min: {defaultValue: 1, values: Settings_jumpTimers.map(String)},
        vod_seek_max: {defaultValue: 11, values: Settings_jumpTimers.map(String)},
        vod_seek_time: {defaultValue: 3} //2000ms growth window
    },
    Settings_jumpTimers,
    Settings_Seek_Time,
    STR_JUMPING_STEP: 'Jump ',
    STR_BR: ' ',
    STR_LOCKED: ' locked',
    STR_UP_LOCKED: ' up locked',
    STR_SECONDS: 's',
    Date: function () {
        return {getTime: () => now};
    },
    OSInterface_gettime: () => 600000,
    OSInterface_mseekTo: ms => seekCalls.push(ms),
    Main_IsOn_OSInterface: true,
    Main_setTimeout: (fn, delay, id) => {
        timers.set(id, {fn, at: now + delay});
        return id;
    },
    Main_clearTimeout: id => timers.delete(id),
    Main_setItem: () => {},
    Main_innerHTMLWithEle: () => {},
    Main_isScene2DocVisible: () => true,
    Play_isPanelShowing: () => panelShowing,
    Play_isVodDialogVisible: () => false,
    Play_isEndDialogVisible: () => false,
    UserLiveFeed_isPreviewShowing: () => false,
    Play_screeOn: () => {},
    Play_clearHidePanel: () => {},
    PlayVod_setHidePanel: () => {},
    PlayVod_showPanel: () => showPanelCalls.push(1),
    PlayVod_jumpTime: () => {},
    PlayVod_SaveVodIds: () => {},
    PlayVod_ChaptersSetGame: () => {},
    PlayVod_UpdateRemaining: () => {},
    PlayVod_ProgressBarrUpdate: () => {},
    PlayVod_previews_clear_img: () => {},
    Play_BottomIconsFocus: () => focusCalls.push(s.PlayVod_PanelY),
    Play_BottomLeftRigt: (row, adder) => iconNavCalls.push([row, adder]),
    PlayerUI_Show: mode => playerUIShowCalls.push(mode),
    Chat_Pause: () => {},
    Chat_VodGap: () => 0,
    Chat_Init: () => {}
};
vm.createContext(s);
vm.runInContext(definitions.join('\n'), s);

let checks = 0;
function check(value, message) {
    assert.ok(value, message);
    checks++;
}
function key(code) {
    s.PlayVod_handleKeyDown({keyCode: code, preventDefault: () => {}});
}
function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
            timers.delete(id);
            timer.fn();
        }
    }
}
function reset(panelY) {
    timers.clear();
    focusCalls.length = 0;
    iconNavCalls.length = 0;
    seekCalls.length = 0;
    showPanelCalls.length = 0;
    playerUIShowCalls.length = 0;
    panelShowing = true;
    s.PlayVod_PanelY = panelY;
    s.PlayVod_addToJump = 0;
    s.PlayVod_TimeToJump = 0;
    s.PlayVod_OldTime = 0;
    s.PlayVod_jumpCount = 1;
    s.PlayVod_IsJumping = false;
}

/* Left/Right from the Pause row (#52): the panel is open with Pause focused */
reset(1);
key(s.KEY_LEFT);
check(s.PlayVod_PanelY === 0, 'Left from the Pause row moves focus to the seek bar');
check(focusCalls.length === 1 && focusCalls[0] === 0, 'the seek bar is focused when moving off the Pause row');
check(s.PlayVod_addToJump === -10, 'Left from the Pause row seeks by the minimum step');
check(iconNavCalls.length === 0, 'the bottom icon row is not navigated');

reset(1);
key(s.KEY_RIGHT);
check(s.PlayVod_addToJump === 10, 'Right from the Pause row seeks forward by the minimum step');

/* Regression: the seek row and the icon row keep their behavior */
reset(0);
key(s.KEY_LEFT);
check(s.PlayVod_addToJump === -10 && !focusCalls.length, 'Left on the seek row seeks without a focus call');

reset(2);
key(s.KEY_LEFT);
check(iconNavCalls.length === 1 && iconNavCalls[0][0] === 2 && iconNavCalls[0][1] === -1, 'Left on the icon row navigates it');
check(s.PlayVod_addToJump === 0, 'Left on the icon row does not seek');

/* Regression: with the panel hidden Left seeks right away and focuses the seek bar */
reset(0);
panelShowing = false;
key(s.KEY_LEFT);
check(showPanelCalls.length === 1, 'a hidden panel is shown before seeking');
check(focusCalls.length === 1 && s.PlayVod_PanelY === 0, 'the seek bar is focused from the hidden panel');
check(s.PlayVod_addToJump === -10, 'Left with the panel hidden seeks right away');

/* Regression: Down from the seek bar still opens the player bar */
panelShowing = true;
reset(0);
key(s.KEY_DOWN);
check(playerUIShowCalls.length === 1 && playerUIShowCalls[0] === 2, 'Down from the seek bar opens the player bar menu');

/* Rapid taps grow the step, same as a held key (#52) */
reset(0);
key(s.KEY_LEFT);
advance(600);
key(s.KEY_LEFT);
check(s.PlayVod_jumpCount === 2, 'a second press within a second grows the step');
check(s.PlayVod_addToJump === -40, 'the burst accumulates the 10s then 30s steps');

reset(0);
key(s.KEY_LEFT);
advance(400);
key(s.KEY_LEFT);
check(s.PlayVod_jumpCount === 2 && s.PlayVod_addToJump === -40, 'held key repeats grow the step');

/* A pause of a second ends the burst: the step starts over */
advance(1100);
key(s.KEY_LEFT);
check(s.PlayVod_jumpCount === 1, 'a press after the pause starts from the minimum step');
check(s.PlayVod_addToJump === -50, 'accumulation continues with the reset step');

/* Enter executes the accumulated seek and ends the burst */
reset(0);
key(s.KEY_LEFT);
key(s.KEY_ENTER);
check(seekCalls.length === 1 && seekCalls[0] === 590000, 'Enter seeks to the accumulated position');
check(s.PlayVod_addToJump === 0 && s.PlayVod_jumpCount === 1 && s.PlayVod_OldTime === 0, 'the burst state resets once the seek executes');

/* The step growth can never index past the step table: vod_seek_max default (11) is one past its
 * last index, without the cap the third press below adds undefined and NaNs the accumulator */
s.Play_DefaultjumpTimers = [5, 10, 30];
reset(0);
key(s.KEY_LEFT);
advance(600);
key(s.KEY_LEFT);
advance(600);
key(s.KEY_LEFT);
check(s.PlayVod_jumpCount === 2, 'growth stops at the last table index');
check(s.PlayVod_addToJump === -70, 'the accumulator stays finite at 10s + 30s + 30s');
s.Play_DefaultjumpTimers = Settings_jumpTimers;

console.log(checks + ' VOD seek checks passed');
