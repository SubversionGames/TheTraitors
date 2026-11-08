// ============================================
// GAME STATE MANAGEMENT
// ============================================

let gameState = {
    phase: 'waiting',
    players: {},
    seats: {},
    timer: null,
    firstVote: null,
    currentRoom: 'main'
};

let currentUser = {
    id: null,
    role: null, // 'host', 'player'
    name: null,
    seat: null
};

// Room seat layout configurations
const ROOM_LAYOUTS = {
    2: { rows: 1, cols: 2, pattern: [2] }, // Side by side
    3: { rows: 2, cols: 2, pattern: [1, 2] }, // Triangle: 1 top, 2 bottom
    4: { rows: 2, cols: 2, pattern: [2, 2] }, // 2 rows of 2
    5: { rows: 2, cols: 3, pattern: [2, 3] }, // 2 top, 3 bottom
    6: { rows: 2, cols: 3, pattern: [3, 3] }, // 2 rows of 3
    7: { rows: 2, cols: 4, pattern: [3, 4] }, // 3 top, 4 bottom
    8: { rows: 2, cols: 4, pattern: [4, 4] }, // 2 rows of 4
    9: { rows: 2, cols: 5, pattern: [4, 5] }, // 4 top, 5 bottom
    10: { rows: 3, cols: 4, pattern: [3, 4, 3] }, // 3-4-3
    15: { rows: 3, cols: 5, pattern: [5, 5, 5] }, // 3 rows of 5
    24: { rows: 3, cols: 8, pattern: [8, 8, 8] } // Default main room
};

// Get exact layout for seat count (no longer finds "closest match")
function getLayoutForSeatCount(seatCount) {
    // Return exact layout if it exists
    if (ROOM_LAYOUTS[seatCount]) {
        return ROOM_LAYOUTS[seatCount];
    }
    
    // For counts between defined layouts, find the next largest
    const availableSizes = [2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 24];
    for (let size of availableSizes) {
        if (seatCount <= size) {
            return ROOM_LAYOUTS[size];
        }
    }
    
    // Fallback to largest
    return ROOM_LAYOUTS[24];
}

// ============================================
// SAFARI AUDIO UNLOCK
// ============================================
// Safari blocks audio unless triggered by a user gesture.
// This unlocks audio on the first tap/click anywhere on the page.
(function() {
    var unlocked = false;
    function unlock() {
        if (unlocked) return;
        unlocked = true;
        // Create and immediately pause a silent audio context
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }
        // Also play+pause a silent buffer to unblock Audio objects
        var buf = ctx.createBuffer(1, 1, 44100);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        document.removeEventListener('touchstart', unlock, true);
        document.removeEventListener('click', unlock, true);
    }
    document.addEventListener('touchstart', unlock, true);
    document.addEventListener('click', unlock, true);
})();

// ============================================
// PHASE MANAGER - Handles clean phase transitions
// ============================================

const PhaseManager = {
    currentPhase: null,
    
    changePhase(newPhase) {
        // Exit current phase
        if (this.currentPhase) {
            console.log(`🚪 Exiting phase: ${this.currentPhase}`);
            
            // Call the appropriate exit function
            const exitFunctionName = `exit${this.currentPhase.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')}`;
            
            // Try to call it if it exists
            try {
                if (typeof window[exitFunctionName] === 'function') {
                    window[exitFunctionName]();
                }
            } catch (e) {
                console.log('No exit function for:', this.currentPhase);
            }
        }
        
        // Update phase
        this.currentPhase = newPhase;
        console.log(`🚪 Entering phase: ${newPhase}`);
    }
};

// ============================================
// INITIALIZATION
// ============================================

async function initializeGame() {
    // Initialize main seat count from Firebase
    const mainLimitSnapshot = await database.ref('game/roomLimits/main').once('value');
    window.currentMainSeatCount = mainLimitSnapshot.val() || 24;
    console.log(`Initial main room seat count: ${window.currentMainSeatCount}`);
    
    // Use window.currentUser if it exists (set by player.html), otherwise create from sessionStorage
    if (window.currentUser && window.currentUser.id) {
        console.log('Using existing window.currentUser:', window.currentUser.id);
        currentUser = window.currentUser;
    } else {
        console.log('Creating currentUser from sessionStorage');
        currentUser.role = sessionStorage.getItem('userRole');
        currentUser.name = sessionStorage.getItem('playerName');
        currentUser.id = sessionStorage.getItem('userId') || generateUserId();
        currentUser.seat = sessionStorage.getItem('playerSeat')
            || sessionStorage.getItem('prodLetter') // prod members store their seat as prodLetter
            || null;
        sessionStorage.setItem('userId', currentUser.id);
        window.currentUser = currentUser;
    }
    
    // Listen to game state changes
    setupFirebaseListeners();
    
    // Initialize video seats after browser layout is complete.
    // Double-requestAnimationFrame waits for the browser to finish layout AND paint
    // before measuring viewport dimensions, so seats appear immediately in the
    // correct position with no flash or snap-to-correct-position delay.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        generateVideoSeats();
    }));
    
    // Listen for changes to main room seat count
    database.ref('game/roomLimits/main').on('value', (snapshot) => {
        const newSeatCount = snapshot.val();
        if (newSeatCount && newSeatCount !== window.currentMainSeatCount) {
            console.log(`Main room seat count changed from ${window.currentMainSeatCount} to ${newSeatCount}`);
            
            // Store current player assignments BEFORE regenerating
            const currentAssignments = {};
            database.ref('players').once('value', (playersSnapshot) => {
                const players = playersSnapshot.val() || {};
                for (let playerId in players) {
                    const _p = players[playerId];
                    // Skip host and prod members — their letter seats are managed separately
                    if (_p.isHost || _p.isProdMember) continue;
                    if (_p.seat && typeof _p.seat === 'number') {
                        currentAssignments[playerId] = {
                            seat: _p.seat,
                            name: _p.name
                        };
                    }
                }
                
                // Update count
                window.currentMainSeatCount = newSeatCount;
                
                // Only regenerate if we've already generated seats once
                if (window.seatsGenerated) {
                    // Write seat restorations to Firebase BEFORE regenerating seats.
                    // This way when generateVideoSeats() triggers the players listener,
                    // the correct player→seat mappings are already in Firebase and
                    // seats show names immediately — no flicker to 'Empty'.
                    const restorationUpdates = {};
                    const displacedPlayers = {}; // players whose seat no longer exists

                    for (const playerId in currentAssignments) {
                        const assignment = currentAssignments[playerId];
                        if (assignment.seat <= newSeatCount) {
                            // Seat still exists — re-affirm game/seats entry
                            restorationUpdates['game/seats/' + assignment.seat] = playerId;
                        } else {
                            // Seat removed — will need to find new seat
                            displacedPlayers[playerId] = assignment;
                        }
                    }

                    // Write valid restorations immediately (no delay)
                    if (Object.keys(restorationUpdates).length) {
                        database.ref().update(restorationUpdates);
                    }

                    // Now regenerate seat DOM — players listener will fire with
                    // correct data already in Firebase
                    regenerateSeatsWithNewCount(newSeatCount);

                    // Handle displaced players (their seat was removed) after a short delay
                    if (Object.keys(displacedPlayers).length) {
                        setTimeout(() => {
                            database.ref('game/seats').once('value', (seatsSnap) => {
                                const seats = seatsSnap.val() || {};
                                const displacedUpdates = {};
                                for (const playerId in displacedPlayers) {
                                    const assignment = displacedPlayers[playerId];
                                    for (let i = 2; i <= newSeatCount; i++) {
                                        if (!seats[i] && !displacedUpdates['game/seats/' + i]) {
                                            displacedUpdates['game/seats/' + i] = playerId;
                                            displacedUpdates['players/' + playerId + '/seat'] = i;
                                            console.log(`✅ Moved ${assignment.name} to seat ${i}`);
                                            break;
                                        }
                                    }
                                }
                                if (Object.keys(displacedUpdates).length) {
                                    database.ref().update(displacedUpdates);
                                }
                                window._regeneratingSeats = false;
                            });
                        }, 200);
                    } else {
                        // No displaced players — clear flag after DOM settles
                        setTimeout(() => { window._regeneratingSeats = false; }, 200);
                    }
                } else {
                    generateVideoSeats();
                }
            });
        }
    });
    
    console.log('Game initialized for:', currentUser.role);
    if (currentUser.role === 'host') {
        _setupSeatSwitchListener();
    }
}

function generateUserId() {
    return currentUser.role + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// ============================================
// FIREBASE LISTENERS
// ============================================

function setupFirebaseListeners() {
    // ============================================================
    // SAFETY GUARD: Prevent duplicate listener registration
    // If this function is ever called a second time (e.g. due to
    // a navigation event or accidental double-call), bail out
    // immediately. All .on() listeners registered here would
    // otherwise fire TWICE for every Firebase update.
    // ============================================================
    if (window._firebaseListenersRegistered) {
        console.warn('⚠️ setupFirebaseListeners() called a second time — skipping to prevent duplicate listeners.');
        return;
    }
    window._firebaseListenersRegistered = true;
    console.log('✅ setupFirebaseListeners() registering listeners for the first (and only) time.');

    // Check for game timeout (1 hour of complete inactivity)
    const ONE_HOUR = 60 * 60 * 1000; // 1 hour in milliseconds
    
    database.ref('game/lastActivity').once('value', (snapshot) => {
        const lastActivity = snapshot.val();
        const now = Date.now();
        
        if (lastActivity && (now - lastActivity) > ONE_HOUR) {
            console.log('⏰ Game timed out after 1 hour of inactivity - resetting to Lobby');
            
            // Reset game to lobby phase
            database.ref('game').set({
                phase: 'lobby',
                started: false,
                lastActivity: now,
                roomLimits: {
                    main: 24
                }
            });
            
            // Clear all player data except host
            database.ref('players').once('value', (playersSnap) => {
                const players = playersSnap.val() || {};
                const updates = {};
                
                for (let playerId in players) {
                    if (players[playerId].isHost) {
                        // Keep host but reset their room to main
                        updates[playerId + '/room'] = 'main';
                        updates[playerId + '/seat'] = 'A';
                    } else {
                        // Remove all non-host players
                        updates[playerId] = null;
                    }
                }
                
                database.ref('players').update(updates);
            });
            
            // Clear all seat assignments
            database.ref('game/seats').remove();
        } else {
            // Game is still active, just update timestamp
            database.ref('game/lastActivity').set(now);
        }
    });
    
    // Update activity timestamp on any interaction
    const updateActivity = () => {
        database.ref('game/lastActivity').set(Date.now());
    };
    
    // Update on various user interactions
    window.addEventListener('click', updateActivity);
    window.addEventListener('keypress', updateActivity);
    
    // Update every 5 minutes while page is open
    setInterval(updateActivity, 5 * 60 * 1000);

    // Listen to game phase changes
    database.ref('game/phase').on('value', (snapshot) => {
        const phase = snapshot.val();
        if (!phase) return;
        sessionStorage.setItem('currentPhase', phase);
        
        // Force phase element update immediately
        const phaseElement = document.getElementById('phase-name');
        if (phaseElement && phase) {
            const phaseNames = {
                'lobby': 'Lobby - Select Your Seat',
                'breakfast': 'Breakfast',
                'talk': 'Talk Time',
                'deliberation': 'Roundtable',
                'first-vote': 'Voting Phase',
                'first-vote-reveal': 'Vote Reveal',
                'second-vote': 'Revote Phase',
                'circle-of-truth': 'Circle of Truth',
                'night': 'Night',
                'end-game': 'End Game'
            };
            if (phaseNames[phase]) {
                phaseElement.textContent = phaseNames[phase];
            }
        }
        
        // Seat visibility is handled by generateVideoSeats() hide-then-reveal pattern.
        // The old polling loop that forced seats visible is removed — it was firing
        // while seats were still being positioned, causing the wrong-position flash.

        // Clean up role reveal text when leaving circle-of-truth
        if (phase !== 'circle-of-truth') {
            const roleRevealText = document.getElementById('role-reveal-text');
            if (roleRevealText) {
                roleRevealText.remove();
            }
            // Also restore phase-name visibility
            const phaseEl = document.getElementById('phase-name');
            const timerEl = document.getElementById('timer');
            if (phaseEl) phaseEl.style.display = 'block';
            if (timerEl && phase !== 'night' && phase !== 'breakfast') {
                // Only show timer if one is actually active in Firebase
                database.ref('game/timer').once('value', (timerSnap) => {
                    const timerData = timerSnap.val();
                    if (timerData && timerData.totalSeconds && timerData.isRunning) {
                        timerEl.style.display = '';
                    }
                    // If no active timer, leave it hidden
                });
            }
        }
        
        // Update the phase title for ALL roles
        handlePhaseChange(phase);
        
        if (currentUser && currentUser.role === 'player') {
            const overlay = document.getElementById('night-overlay');
            const overlayMessage = overlay ? overlay.querySelector('.overlay-message') : null;
            
            if (phase === 'breakfast') {
                // Show breakfast overlay IMMEDIATELY — but only if not already visible
                // (player.html has its own #breakfast-overlay; don't double-show)
                const _bfOverlay = document.getElementById('breakfast-overlay');
                const _bfAlreadyVisible = _bfOverlay && _bfOverlay.classList.contains('visible');
                const _nightAlreadyVisible = overlay && overlay.classList.contains('visible');
                if (!_bfAlreadyVisible && !_nightAlreadyVisible && overlay && overlayMessage) {
                    overlayMessage.textContent = 'Breakfast Has Begun...';
                    overlay.style.display = 'flex';
                    overlay.classList.add('visible');
                }
                
                // Hide all seats IMMEDIATELY
                document.querySelectorAll('.video-seat').forEach(seat => {
                    seat.style.display = 'none';
                });
                
                // Send player to waiting room if not already there
                if (currentUser.room !== 'waiting') {
                    database.ref('players/' + currentUser.id + '/room').set('waiting');
                    database.ref('players/' + currentUser.id + '/seat').remove();
                }
                
            } else if (phase === 'night') {
                // Night overlay
                if (overlay && overlayMessage) {
                    overlayMessage.textContent = 'The Traitors Are Meeting In The Turret...';
                    overlay.style.display = 'flex';
                }
                
                // Hide all seats
                document.querySelectorAll('.video-seat').forEach(seat => {
                    seat.style.display = 'none';
                });
                
            } else {
                // Other phases - hide overlay
                if (overlay) {
                    overlay.style.display = 'none';
                }
                
                // Show seats only if in main room
                if (currentUser.room === 'main') {
                    document.querySelectorAll('.video-seat').forEach(seat => {
                        seat.style.display = 'block';
                    });
                }
            }
        }
    });
    
    // ============================================
    // TIMER SYSTEM - COMPLETE MANUAL CONTROL REWRITE
    // ============================================
    
    // Immediately hide timer on page load
    const timerElement = document.getElementById('timer');
    if (timerElement) {
        timerElement.style.display = 'none';
        timerElement.style.visibility = 'hidden';
    }
    
    // Timer listener - delayed initialization with debounce
    let timerListenerActive = false;
    
    setTimeout(() => {
        timerListenerActive = true;
        console.log('🔴 TIMER LISTENER ACTIVATED');
        
        database.ref('game/timer').on('value', (snapshot) => {
            console.log('🔵 Timer listener fired');
            
            // Only run if listener is active
            if (!timerListenerActive) {
                console.log('⛔ Listener not active yet, skipping');
                return;
            }
            
            const timer = snapshot.val();
            console.log('📊 Timer data:', timer);
            
            // No debounce — Firebase .on() only fires on real changes
            console.log('✅ Timer changed, processing...');
            
            const timerElement = document.getElementById('timer');
            const phaseElement = document.getElementById('phase-name');
            
            // Can't do anything without DOM elements
            if (!timerElement || !phaseElement) {
                console.log('❌ DOM elements not found');
                return;
            }
            
            // Get current phase from sessionStorage
            const currentPhase = sessionStorage.getItem('currentPhase') || 'lobby';
            
            // Phase names for display
            const phaseNames = {
                'lobby': 'Lobby - Select Your Seat',
                'breakfast': 'Breakfast',
                'talk': 'Talk Time',
                'deliberation': 'Roundtable',
                'first-vote': 'Voting Phase',
                'first-vote-reveal': 'Vote Reveal',
                'second-vote': 'Revote Phase',
                'circle-of-truth': 'Circle of Truth',
                'night': 'Night'
            };
            
            // NO TIMER DATA: Hide timer and update phase display
            if (!timer || !timer.totalSeconds) {
                console.log('🚫 No timer data - HIDING timer');
                timerElement.style.display = 'none';
                timerElement.style.visibility = 'hidden';
                if (phaseNames[currentPhase]) {
                    phaseElement.textContent = phaseNames[currentPhase];
                }
                phaseElement.style.display = 'block';
                return;
            }

            // CHECK PHASE BEFORE SHOWING TIMER
            if (currentPhase === 'lobby' || currentPhase === 'circle-of-truth') {
                console.log('🚫 Timer hidden (phase:', currentPhase, ')');
                timerElement.style.display = 'none';
                timerElement.style.visibility = 'hidden';
                phaseElement.style.display = 'block';
                if (phaseNames[currentPhase]) {
                    phaseElement.textContent = phaseNames[currentPhase];
                }
                return;
            }

            // TIMER EXISTS AND PHASE ALLOWS IT: Show it
            console.log('✨ Timer exists - SHOWING timer');
            timerElement.style.display = 'block';
            timerElement.style.visibility = 'visible';
            phaseElement.style.display = 'block';
            
            // Use timer label if provided, otherwise use phase name
            if (timer.label && timer.label.trim() !== '') {
                phaseElement.textContent = timer.label;
            } else {
                phaseElement.textContent = phaseNames[currentPhase];
            }
            
            // Calculate display time
            let remaining = timer.remainingSeconds || timer.totalSeconds;
            
            // If timer is running, calculate elapsed time
            if (timer.isRunning && timer.startedAt) {
                const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
                remaining = Math.max(0, timer.totalSeconds - elapsed);
            }
            
            // Display the time
            const minutes = Math.floor(remaining / 60);
            const seconds = remaining % 60;
            const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            timerElement.textContent = timeString;
            console.log('⏱️ Timer set to:', timeString);
        });
    }, 1500); // 1.5 second delay before starting listener
    
    // Timer countdown interval (HOST ONLY updates Firebase)
    setInterval(() => {
        if (currentUser && currentUser.role === 'host') {
            database.ref('game/timer').once('value', (snapshot) => {
                const timer = snapshot.val();
                if (!timer || !timer.isRunning) return;
                
                if (timer.startedAt) {
                    const elapsed = Math.floor((Date.now() - timer.startedAt) / 1000);
                    const remaining = Math.max(0, timer.totalSeconds - elapsed);
                    
                    // Update remaining seconds in Firebase
                    if (remaining !== timer.remainingSeconds) {
                        database.ref('game/timer/remainingSeconds').set(remaining);
                    }
                    
                    // Timer just hit zero
                    if (remaining === 0 && timer.isRunning) {
                        console.log('⏰ TIMER EXPIRED');
                        database.ref('game/timer/isRunning').set(false);
                        
                        // Check current phase for special animations
                        database.ref('game/phase').once('value', (phaseSnapshot) => {
                            const currentPhase = phaseSnapshot.val();
                            
                            if (currentPhase === 'first-vote' || currentPhase === 'second-vote') {
                                console.log('🔔 VOTING TIMER EXPIRED');
                                
                                // Play gong sound
                                const gong = new Audio('gong.mp3');
                                gong.volume = 0.7;
                                gong.play().catch(err => console.error('Gong failed:', err));
                                
                                // Lock votes
                                database.ref('game/firstVote/votingLocked').set(true);
                                
                                // Show voting ended animation
                                database.ref('game/firstVoteEndedAnimation').set(true);
                                setTimeout(() => {
                                    database.ref('game/firstVoteEndedAnimation').remove();
                                }, 6000);
                                
                                // Auto-vote non-voters
                                if (typeof window.autoVoteNonVoters === 'function') {
                                    window.autoVoteNonVoters();
                                }
                                
                            } else if (currentPhase === 'talk') {
                                console.log('🔔 TALK TIMER EXPIRED - Return to roundtable');
                                
                                // Play roundtable gong
                                const gong = new Audio('gong.mp3');
                                gong.volume = 0.7;
                                gong.play().catch(err => console.error('Gong failed:', err));
                                
                                // Show roundtable animation
                                database.ref('game/roundtableGong').set(true);
                                setTimeout(() => {
                                    database.ref('game/roundtableGong').remove();
                                }, 6000);
                            }
                            
                            // Remove timer completely after expiration
                            setTimeout(() => {
                                database.ref('game/timer').remove();
                            }, 1000);
                        });
                    }
                }
            });
        }
    }, 1000);

    // ============================================
    // FORCE RESET LISTENER (ALL USERS)
    // ============================================
    // When host clicks Reset Game, ALL pages reload — including prod tabs
    let _lastForceReset = null;
    database.ref('game/forceReset').on('value', (snap) => {
        const val = snap.val();
        if (!val) return;
        if (_lastForceReset === val) return; // dedupe
        _lastForceReset = val;
        // Only react if the signal is RECENT (within 5 seconds).
        const _ageMs = Date.now() - val;
        if (_ageMs > 5000) {
            console.log('⏩ forceReset signal is stale (' + Math.round(_ageMs/1000) + 's old) — ignoring');
            return;
        }
        // Main host does NOT reload — they do a soft in-place reset.
        // Only players and prod members reload.
        const _cu = window.currentUser;
        const _isMainHost = _cu && _cu.id === 'host' || 
            (_cu && _cu.role === 'host' && !_cu.isProdMember && 
             (_cu.id === 'host' || (_cu.id && !_cu.id.startsWith('prod-'))));
        if (_isMainHost) {
            console.log('⏩ forceReset: main host skips reload (soft reset already done)');
            return;
        }
        console.log('🔄 Force reset signal received — performing soft reset');
        // ── Soft reset: player stays seated and connected, no page reload ──
        // Players keep their seat/room/LiveKit connection. We only clear
        // game-UI state that won't be cleared by the Firebase phase → 'lobby' listener.

        // 1. Clear in-memory game-state flags (role, vote — NOT seat/room)
        // For prod members, preserve their role — only player game-roles (traitor/faithful)
        // need clearing. Prod members keep their host/prod identity.
        if (window.currentUser && !window.currentUser.isProdMember) {
            window.currentUser.role = 'player'; // role will be re-assigned next game
        }
        if (!currentUser.isProdMember) currentUser.role = 'player';

        // 2. Clear any phase overlays that might be visible
        ['night-overlay','breakfast-overlay'].forEach(id => {
            const _ov = document.getElementById(id);
            if (_ov) { _ov.classList.remove('visible'); _ov.style.display = 'none'; }
        });
        // Restore seat/tab visibility (lobby shows seats)
        document.querySelectorAll('.video-seat').forEach(s => {
            s.style.removeProperty('display');
            s.style.removeProperty('visibility');
        });
        const _tabCont = document.querySelector('.tab-container');
        if (_tabCont) { _tabCont.style.removeProperty('display'); _tabCont.style.removeProperty('visibility'); }

        // 3. Clear vote pill overlays and tally UI
        ['vote-pill-overlay','vote-pill-overlay-second','banishment-vote-pill-overlay',
         'banishment-vote-pill-overlay-second','role-reveal-text'].forEach(id => {
            const _el = document.getElementById(id);
            if (_el) _el.style.display = 'none';
        });
        const _ftc = document.getElementById('first-vote-tally-content');
        if (_ftc) _ftc.innerHTML = '<p style="color:#bbb;text-align:center;">No votes revealed yet</p>';
        const _stc = document.getElementById('second-vote-tally-content');
        if (_stc) _stc.innerHTML = '';
        const _stEl = document.getElementById('second-vote-tally');
        if (_stEl) _stEl.style.display = 'none';

        // 4. Reset CoT seat if active (restores z-index and transform)
        //    Also clear any banishment/vote reveal glows.
        if (typeof _resetCotSeat === 'function') _resetCotSeat(window._lastCotSeat);
        for (let _ci = 1; _ci <= 25; _ci++) {
            const _cs = document.getElementById('seat-' + _ci);
            if (_cs) {
                _cs.style.removeProperty('z-index');
                _cs.style.transform  = 'translate(-50%, -50%)';
                _cs.style.boxShadow  = ''; // clear banishment/vote glow
                _cs.style.border     = ''; // clear banishment/vote border
            }
        }

        // 5. Clear vote name-tag highlights from seat labels
        //    Also clear pronouns showingVote so updatePlayerDisplay can restore them.
        for (let _si = 1; _si <= 25; _si++) {
            const _ni = document.getElementById('name-' + _si);
            if (_ni) {
                delete _ni.dataset.showingVote;
                _ni.style.fontFamily = 'Arial, sans-serif';
                _ni.style.fontSize   = '1.2rem';
                _ni.style.color      = '#fff';
                _ni.style.textAlign  = '';
                _ni.style.visibility = '';
                _ni.style.display    = '';
            }
            const _pi = document.getElementById('pronouns-' + _si);
            if (_pi) {
                delete _pi.dataset.showingVote;
                _pi.style.visibility = '';
                _pi.style.display    = '';
                _pi.style.color      = '';
            }
            // Restore player name/pronouns immediately from gameState cache
            const _player = gameState && gameState.players &&
                Object.values(gameState.players).find(p => p.seat === _si);
            if (_player && _ni) {
                _ni.textContent = _player.name || 'Unknown';
                if (_pi) _pi.textContent = _player.pronouns || '';
            } else if (!_player && _ni) {
                // Seat is empty — clear to Empty state
                _ni.style.fontFamily = '';
                _ni.style.fontSize   = '';
                _ni.style.color      = '';
                _ni.textContent = 'Empty';
                if (_pi) _pi.textContent = '';
            }
        }

        // 6. Clear stale phase from sessionStorage (Firebase phase listener
        //    will re-set it when 'lobby' fires)
        sessionStorage.removeItem('currentPhase');

        console.log('✅ Player soft reset complete — seat and connection preserved');
    });

    // prodReset: prod member pages clear their sessionStorage so they don't
    // auto-reclaim their old seat after a full game reset
    const _isProdMember = currentUser && currentUser.isProdMember;
    if (_isProdMember) {
        let _lastProdReset = null;
        database.ref('game/prodReset').on('value', (snap) => {
            const val = snap.val();
            if (!val) return;
            if (_lastProdReset === val) return;
            _lastProdReset = val;
            if (Date.now() - val > 5000) return; // stale — ignore
            console.log('🔄 Prod reset signal — clearing prod sessionStorage');
            sessionStorage.removeItem('prodLetter');
            sessionStorage.removeItem('playerSeat');
            sessionStorage.removeItem('playerName');
            // Reload is handled by the forceReset listener above
        });
    }

    // ============================================
    // REMOVED PROD SEAT LISTENER (PROD MEMBERS)
    // ============================================
    // When the host removes a specific prod seat, that member's page clears its
    // sessionStorage and reloads so the device returns to a fresh state.
    {
        const _myProdLetter = sessionStorage.getItem('prodLetter');
        if (_myProdLetter) {
            let _lastRemovedSeat = null;
            database.ref('game/removedProdSeat').on('value', (snap) => {
                const val = snap.val();
                if (!val || !val.letter || !val.ts) return;
                if (_lastRemovedSeat === val.ts) return; // dedupe
                _lastRemovedSeat = val.ts;
                if (Date.now() - val.ts > 5000) return; // stale — ignore
                if (val.letter !== _myProdLetter) return; // not my seat
                console.log('🔄 My prod seat was removed — clearing session and reloading');
                // Clear prod-specific sessionStorage so we don't auto-reclaim
                sessionStorage.removeItem('prodLetter');
                sessionStorage.removeItem('playerSeat');
                sessionStorage.removeItem('playerName');
                sessionStorage.removeItem('isProduction');
                setTimeout(() => window.location.reload(), 500);
            });
        }
    }

    // ============================================
    // VOTES RESET LISTENER (ALL USERS)
    // ============================================
    // When host clicks Reset Votes, all clients restore name boxes to player names
    database.ref('game/votesReset').on('value', (snapshot) => {
        if (!snapshot.val()) return;
        console.log('🔄 Votes reset signal received — restoring name boxes');
        // Restore all name tags from gameState with full style reset
        for (let i = 1; i <= 25; i++) {
            const nameEl  = document.getElementById('name-' + i);
            const pronEl  = document.getElementById('pronouns-' + i);
            const seatLbl = nameEl ? nameEl.parentElement : null;
            if (!nameEl) continue;
            const player = Object.values(gameState.players || {}).find(p => p.seat === i);
            if (player) {
                // Full inline style reset (clears ShootingStar font, visibility, etc.)
                nameEl.style.cssText       = '';
                nameEl.textContent         = player.name || 'Unknown';
                nameEl.style.color         = '#fff';
                nameEl.style.fontSize = _nameFontSize();
                nameEl.style.fontFamily    = 'Arial, sans-serif';
                nameEl.style.visibility    = 'visible';
                nameEl.dataset.showingVote = '';
                if (pronEl) {
                    pronEl.style.cssText       = '';
                    pronEl.textContent         = player.pronouns || '';
                    pronEl.style.visibility    = 'visible';
                    pronEl.style.display       = 'block';
                    pronEl.style.opacity       = player.pronouns ? '0.7' : '0.4';
                    pronEl.dataset.showingVote = '';
                }
                if (seatLbl) {
                    seatLbl.style.background    = '';
                    seatLbl.dataset.showingVote = '';
                }
            } else if (!window._regeneratingSeats) {
                // Empty seat (skip during seat regeneration to avoid flicker)
                nameEl.style.fontFamily = 'Arial, sans-serif';
                nameEl.style.fontSize = _nameFontSize();
                nameEl.style.color      = '#fff';
                nameEl.style.textAlign  = '';
                nameEl.style.visibility = '';
                nameEl.style.display    = '';
                nameEl.textContent         = 'Empty';
                nameEl.dataset.showingVote = '';
                if (pronEl) {
                    pronEl.style.visibility = '';
                    pronEl.style.display    = '';
                    pronEl.style.color      = '';
                    pronEl.textContent = '';
                }
            }
            // Remove glows
            const seatEl = document.getElementById('seat-' + i);
            if (seatEl) {
                seatEl.style.boxShadow = '';
                seatEl.style.border    = '';
                seatEl.classList.remove('yellow-glow', 'purple-glow');
            }
        }
        // Clear vote tally panels (host-side and player-side IDs)
        const panels = ['original-count','reveal-count','revote-tally-list','revote-reveal-count',
                        'second-vote-tally-content'];
        panels.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<div style="color:#666;">No votes yet</div>';
        });
        // Hide second vote sections (both host-side and player-side)
        ['second-vote-count','revote-reveal-section','second-vote-section'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    });


    // Helper: hand indicator style — 40% of seat width, left-of-centre
    function _handIndicatorStyle(seatEl) {
        // Use stored global seat size (set during generateVideoSeats / generateRoomSeats)
        // to ensure consistent 40% scaling regardless of when the listener fires.
        const isRoomSeat = seatEl && seatEl.id && seatEl.id.startsWith('room-seat-');
        let size;
        if (isRoomSeat) {
            size = window.currentRoomSeatSize || parseFloat(seatEl.style.width) || 120;
        } else {
            size = window.currentPlayerSize   || parseFloat(seatEl && seatEl.style.width) || 150;
        }
        const fs     = Math.round(size * 0.40); // 40% of seat diameter
        // Position at ~7:30 on the circle (225° = bottom-left)
        const leftPx   = Math.round(size * -0.05); // just outside left edge
        const bottomPx = Math.round(size * -0.05); // just below bottom-left rim
        return [
            'position:absolute',
            'bottom:' + bottomPx + 'px',
            'left:' + leftPx + 'px',
            'font-size:' + fs + 'px',
            'line-height:1',
            'pointer-events:none',
            'z-index:200',
            'filter:drop-shadow(0 0 6px rgba(255,200,0,0.9))',
        ].join(';');
    }

    // ============================================
    // RAISE HAND LISTENER (ALL USERS)
    // ============================================
    // When any player sets handRaised=true in Firebase, show ✋ on their seat.
    // Works for numeric seats AND prod letter seats.
    // ── CONSOLIDATED PLAYERS LISTENER ──────────────────────────────────────────
    // Single Firebase listener fans out to multiple handlers.
    // Replaces 3 separate players.on() calls → cuts Firebase reads by 2/3.
    window._playersHandlers = [];
    database.ref('players').on('value', (playersSnap) => {
        if (!playersSnap.val()) return;
        window._playersHandlers.forEach(fn => { try { fn(playersSnap); } catch(e) { console.error('Players handler error:', e); } });
    });

    // Handler 1: Hand-raise indicators on seats
    window._playersHandlers.push((playersSnap) => {
        const _HAND_BLOCKED = ['night', 'breakfast'];
        const _curPhase = (window._currentPhase || sessionStorage.getItem('currentPhase') || '').toLowerCase();
        const _phaseAllowed = !_HAND_BLOCKED.some(b => _curPhase.includes(b));

        playersSnap.forEach((child) => {
            const player = child.val();
            if (!player || !player.seat) return;
            const seatId = 'seat-' + player.seat;
            const seatEl = document.getElementById(seatId);
            if (!seatEl) return;

            // Remove any existing hand indicator from main seat
            const existing = seatEl.querySelector('.hand-raised-indicator');
            if (existing) existing.remove();

            // If player is in a breakout room, also clear main seat hand
            // and instead show hand on their breakout room seat
            const inBreakout = player.room && player.room !== 'main' && player.roomSeat;

            if (inBreakout) {
                // Remove from main seat (already done above), add to room seat
                const roomSeatEl = document.getElementById('room-seat-' + player.roomSeat);
                if (roomSeatEl) {
                    const existingRoom = roomSeatEl.querySelector('.hand-raised-indicator');
                    if (existingRoom) existingRoom.remove();
                }
                if (player.handRaised && _phaseAllowed && roomSeatEl) {
                    const hand = document.createElement('div');
                    hand.className = 'hand-raised-indicator';
                    hand.textContent = '✋';
                    hand.style.cssText = _handIndicatorStyle(roomSeatEl);
                    roomSeatEl.appendChild(hand);
                }
            } else if (player.handRaised && _phaseAllowed) {
                // Player is in main room — show on their main seat
                const hand = document.createElement('div');
                hand.className = 'hand-raised-indicator';
                hand.textContent = '✋';
                hand.style.cssText = _handIndicatorStyle(seatEl);
                seatEl.appendChild(hand);
            }
        });
    });

    // ============================================
    // HAND QUEUE — ordered list of raised hands
    // ============================================
    // The HOST maintains game/handQueue (an array of player IDs in raise order).
    // All clients display the queue; only the host writes to it.

    // A) Display listener — fires for everyone, updates host panel
    database.ref('game/handQueue').on('value', (qSnap) => {
        const listEl = document.getElementById('hand-queue-list');
        if (!listEl) return; // only exists on host page
        const emptyEl = document.getElementById('hand-queue-empty');
        const queue = qSnap.val() || [];

        // Remove all existing entries (but keep the empty placeholder)
        listEl.querySelectorAll('.hand-queue-entry').forEach(el => el.remove());

        if (queue.length === 0) {
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        queue.forEach((playerId, idx) => {
            const player = gameState.players && gameState.players[playerId];
            const name = player ? (player.name || playerId) : playerId;
            const entry = document.createElement('div');
            entry.className = 'hand-queue-entry';
            entry.style.cssText = [
                'display:flex',
                'align-items:center',
                'gap:8px',
                'padding:5px 4px',
                'border-bottom:1px solid rgba(255,255,255,0.07)',
                'color:#e0e0e0',
            ].join(';');
            entry.innerHTML = `<span style="color:#888;min-width:18px;font-size:0.8rem;">${idx + 1}.</span>`
                + `<span style="font-weight:600;">${name}</span>`;
            listEl.appendChild(entry);
        });
    });

    // B) Host-only: watch each player's handRaised field and maintain queue order
    if (currentUser.role === 'host') {
        // Track previous handRaised states so we only act on changes
        const _prevHandState = {};

        window._playersHandlers.push((pSnap) => {
            if (!pSnap.val()) return;
            const _phase = (window._currentPhase || '').toLowerCase();
            const _blocked = ['night','breakfast'].some(b => _phase.includes(b));

            pSnap.forEach((child) => {
                const pid = child.key;
                const player = child.val();
                if (!player || player.isHost || player.isProdMember || player.isObserver) return;
                const nowRaised = !!player.handRaised;
                const wasRaised = !!_prevHandState[pid];
                if (nowRaised === wasRaised) return; // no change
                _prevHandState[pid] = nowRaised;

                if (_blocked) return; // don't update queue during night/breakfast

                // Read current queue, then update atomically
                database.ref('game/handQueue').once('value', (qSnap) => {
                    let queue = qSnap.val() || [];
                    // Remove player from wherever they are in the queue
                    queue = queue.filter(id => id !== pid);
                    if (nowRaised) {
                        // Append to end (new raise or re-raise after lowering)
                        queue.push(pid);
                        console.log('✋ Hand queue: added', player.name, '→ queue:', queue.length);
                    } else {
                        console.log('✋ Hand queue: removed', player.name, '→ queue:', queue.length);
                    }
                    database.ref('game/handQueue').set(queue.length > 0 ? queue : null);
                });
            });
        });

        // Clear the queue when night phase starts (hands are cleared)
        database.ref('game/phase').on('value', (phSnap) => {
            const ph = phSnap.val();
            if (ph === 'night' || ph === 'breakfast') {
                database.ref('game/handQueue').remove();
                console.log('✋ Hand queue cleared for', ph, 'phase');
            }
        });
    }

    // ============================================
    // VOTING ENDED ANIMATION LISTENER (ALL USERS)
    // ============================================
    
    // Players listen for voting ended animation to play gong
    if (currentUser.role === 'player') {
        database.ref('game/firstVoteEndedAnimation').on('value', (snapshot) => {
            if (snapshot.val() === true) {
                console.log('🔔 VOTING ENDED - Playing gong for player');
                
                // Play gong sound
                const gong = new Audio('gong.mp3');
                gong.volume = 0.7;
                gong.play().catch(err => console.error('Gong failed:', err));
            }
        });
    }

    // Listen to player changes
    // Handler 3: Main player display update + seat corruption fix
    window._playersHandlers.push((snapshot) => {
        const players = snapshot.val() || {};
        // Sanitize: if host or prod member has a numeric seat (corruption),
        // fix it immediately in Firebase so it doesn't display on a player seat.
        const _seatFixes = {};
        for (const _pid in players) {
            const _pp = players[_pid];
            if ((_pp.isHost || _pp.isProdMember) && typeof _pp.seat === 'number') {
                const _correctSeat = _pp.isHost ? 'A' : (_pp.prodLetter || null);
                if (_correctSeat) {
                    _seatFixes['players/' + _pid + '/seat'] = _correctSeat;
                    // Also clear the corrupt numeric seat entry
                    _seatFixes['game/seats/' + _pp.seat] = null;
                    // Correct the local object so display isn't corrupted
                    players[_pid] = Object.assign({}, _pp, { seat: _correctSeat });
                    console.log('🔧 Fixed corrupt numeric seat for', _pid, '→', _correctSeat);
                }
            }
        }
        if (Object.keys(_seatFixes).length) database.ref().update(_seatFixes);
        gameState.players = players;
        updatePlayerDisplay();
        if (typeof window._refreshAVIcons === 'function') window._refreshAVIcons();
    });

    // ============================================
    // MAIN PHASE LISTENER - Handles all phase changes
    // ============================================
    
    database.ref('game/phase').on('value', (snapshot) => {
        const newPhase = snapshot.val();
        console.log('Phase changed to:', newPhase);
        
        // Exit current phase and enter new one
        PhaseManager.changePhase(newPhase);
        
        // Enter new phase
        switch(newPhase) {
            case 'first-vote':
                enterVoting();
                break;
            case 'first-vote-reveal':
                // Voting listener is already active, do nothing
                break;
            case 'second-vote':
                enterRevote();
                break;
            case 'second-vote-reveal':
                enterRevoteReveal();
                break;
            case 'circle-of-truth':
                enterCircleOfTruth();
                break;
            case 'lobby':
                // Lobby has no special setup
                break;
            case 'night':
                enterNightPhase();
                // Night = start of a new round — clear vote tallies on all clients.
                // Host DOM clearing is handled by the resetVotes() path or the
                // Firebase removals. On player side, clear the tally display.
                if (currentUser.role === 'player') {
                    const _ntc = document.getElementById('first-vote-tally-content');
                    if (_ntc) _ntc.innerHTML = '<p style="color:#bbb;text-align:center;">No votes revealed yet</p>';
                    const _ntc2 = document.getElementById('second-vote-tally-content');
                    if (_ntc2) _ntc2.innerHTML = '';
                    const _nts = document.getElementById('second-vote-tally');
                    if (_nts) _nts.style.display = 'none';
                }
                if (currentUser.role === 'host') {
                    const _tallyEmpty = '<div style="color:#666;">No votes cast yet</div>';
                    const _revealEmpty = '<div style="color:#666;">No votes revealed yet</div>';
                    ['original-count','current-count'].forEach(id => {
                        const _t = document.getElementById(id);
                        if (_t) _t.innerHTML = _tallyEmpty;
                    });
                    ['reveal-count','revote-count','revote-reveal-count'].forEach(id => {
                        const _t = document.getElementById(id);
                        if (_t) _t.innerHTML = _revealEmpty;
                    });
                }
                break;
            case 'breakfast':
                enterBreakfastPhase();
                break;
            case 'end-game':
                // End Game phase — players stay visible, seats remain
                break;
            case 'talk':
            case 'deliberation':
            case 'roundtable':
            case 'waiting':
                // Display-only phases — no special JS logic needed
                break;
            default:
                console.log('Unknown phase:', newPhase);
        }
        // Re-apply mute/cam-off icons after any phase change
        setTimeout(() => {
            if (typeof window._refreshAVIcons === 'function') window._refreshAVIcons();
            // Reset end-game reveal flag when entering non-end-game phases
            const _phNow = (window._currentPhase || '').toLowerCase();
            if (!_phNow.startsWith('end') && _phNow !== 'lobby' && _phNow.includes('vote') && !_phNow.includes('reveal')) {
                window._endGameRevealActive = false;
            }
            // Re-evaluate viewer mode display (reveal phases override viewer mode)
            if (typeof window.applyViewerMode === 'function' && window.viewerModeEnabled) {
                window.applyViewerMode(true);
            }
        }, 200);
    });
    
    // ============================================
    // VOTING PHASE
    // ============================================

    function enterVoting() {
        console.log('📥 ENTERING VOTING PHASE');
        
        // Only players can vote
        if (currentUser.role !== 'player') return;
        
        // Listen for voting phase updates - STORE REFERENCE
        window.votingListener = (snapshot) => {
            console.log('🔔 Voting listener fired, phase:', document.getElementById('phase-name')?.textContent);
            const voting = snapshot.val();
            if (!voting) {
                console.log('⚠️ No voting data');
                // Close pill overlay if voting was reset
                if (typeof window.closeVotePillOverlay === 'function') {
                    window.closeVotePillOverlay();
                }
                return;
            }
            console.log('📊 Voting data:', voting);
            
            // Only show reveal controls if revealed is active
            if (voting.revealed && currentUser && currentUser.id) {
                // Close the vote pill overlay immediately when reveal starts
                if (typeof window.closeVotePillOverlay === 'function') {
                    window.closeVotePillOverlay();
                }
                console.log('✅ REVEAL MODE ACTIVE');
                console.log('  Current revealer:', voting.currentRevealer);
                console.log('  My ID:', currentUser.id);
                console.log('  Match?', voting.currentRevealer === currentUser.id);
                
                // Update phase title FIRST - for ALL players
                const revealerId = voting.currentRevealer;
                if (revealerId) {
                    // Look up player in gameState (which we already have)
                    const revealer = gameState.players[revealerId];
                    if (revealer && revealer.name) {
                        const phaseTitle = document.getElementById('phase-name');
                        if (phaseTitle) {
                            phaseTitle.textContent = `${revealer.name} is revealing their vote.`;
                            console.log('✅ Updated phase title to:', phaseTitle.textContent);
                        }
                    } else {
                        console.log('⚠️ Revealer not found in gameState:', revealerId);
                    }
                } else {
                    console.log('⚠️ No current revealer');
                }
                
                // THEN check if it's my turn to reveal
                if (voting.currentRevealer === currentUser.id) {
                    const votedSeat = voting.votes?.[currentUser.id];
                    if (votedSeat && !voting.alreadyRevealed?.[currentUser.id]) {
                        // Show reveal button
                        showRevealButton();
                        
                        // Listen for spacebar
                        document.addEventListener('keydown', handleRevealKeypress);
                    }
                } else {
                    hideRevealButton();
                    document.removeEventListener('keydown', handleRevealKeypress);
                }
            } else {
                // During second-vote-reveal, the secondVoteReveal listener owns the
                // reveal button. Don't let the votingListener (game/firstVote) hide it.
                if (window._currentPhase !== 'second-vote-reveal') {
                    hideRevealButton();
                    document.removeEventListener('keydown', handleRevealKeypress);
                }
                // Show pill overlay when voting is active and not yet in reveal
                // Don't re-open if player already voted this round
                if (voting.active && !voting.votingLocked && !window.votePillLocked) {
                    // During second-vote phase, game/firstVote/active is set to true
                    // by the host to re-enable voting mechanics. This listener fires
                    // but must NOT open the first-vote pill (which shows ALL players).
                    // The second-vote pill (tied players only) is opened by the
                    // game/secondVote/active listener instead.
                    const _isRevotePhase = window._currentPhase === 'second-vote';
                    if (_isRevotePhase) {
                        // Second-vote phase: show the TIED-players pill — but only if it
                        // isn't already showing the correct (isRevote) version.
                        // The secondVote/active listener opens it first; this guard prevents
                        // a second rapid call that would double-populate the pills.
                        const _pillEl = document.getElementById('vote-pill-overlay');
                        const _pillOpen = _pillEl && _pillEl.style.display !== 'none';
                        if (!_pillOpen && typeof window.showVotePillOverlay === 'function' && !window.votePillLocked) {
                            window.showVotePillOverlay(true); // true = revote, shows tied players only
                        }
                    } else {
                        // First-vote phase: open pill if not already showing
                        // If player has a pending selection, showVotePillOverlay
                        // will guard against rebuild internally.
                        const _pillOverlay = document.getElementById('vote-pill-overlay');
                        const _pillAlreadyOpen = _pillOverlay && _pillOverlay.style.display !== 'none';
                        if (!_pillAlreadyOpen && typeof window.showVotePillOverlay === 'function') {
                            window.showVotePillOverlay(false);
                        }
                        // If pill IS open but no selection yet, also safe — overlay stays as-is
                    }
                } else if (voting.revealed || voting.votingLocked) {
                    // Voting ended or reveal started — close the overlay
                    if (typeof window.closeVotePillOverlay === 'function') {
                        window.closeVotePillOverlay();
                    }
                }
            }
        };

        // Attach the listener
        database.ref('game/firstVote').on('value', window.votingListener);
        console.log('✅ Voting listener attached');

        // MERGED: Single listener for revote reveal (phase title + reveal button)
        // Previously two separate listeners on the same path caused double-firing.
        database.ref('game/secondVoteReveal').on('value', (snapshot) => {
            const revoteRevealData = snapshot.val();
            const phaseName = document.getElementById('phase-name');

            console.log('🔄 REVOTE REVEAL LISTENER FIRED:', revoteRevealData);

            // --- PART 1: Update phase title ---
            if (phaseName) {
                if (revoteRevealData && revoteRevealData.active) {
                    const currentIndex = revoteRevealData.currentIndex || 0;
                    const revealOrder = revoteRevealData.revealOrder || [];
                    const currentRevealerId = revealOrder[currentIndex];

                    if (currentRevealerId) {
                        database.ref(`players/${currentRevealerId}`).once('value', (playerSnap) => {
                            const revealerData = playerSnap.val();
                            if (revealerData) {
                                phaseName.textContent = `${revealerData.name} is revealing their vote.`;
                                console.log(`🔄 REVOTE REVEAL: Phase title updated to "${revealerData.name} is revealing their vote."`);
                            }
                        });
                    }
                } else {
                    database.ref('game/phase').once('value', (phaseSnap) => {
                        if (phaseSnap.val() === 'second-vote') {
                            phaseName.textContent = 'Revote Phase';
                            console.log('✅ REVOTE: Phase title set to "Revote Phase"');
                        }
                    });
                }
            }

            // --- PART 2: Remove purple glow when reveal starts ---
            if (revoteRevealData && revoteRevealData.active) {
                for (let i = 1; i <= 25; i++) {
                    const seat = document.getElementById(`seat-${i}`);
                    if (seat) {
                        const currentShadow = seat.style.boxShadow;
                        if (currentShadow.includes('138, 43, 226')) {
                            seat.style.boxShadow = '';
                            seat.style.border = '';
                            console.log(`💜 Removed purple glow from seat ${i}`);
                        }
                    }
                }
            }

            // --- PART 3: Show/hide reveal button based on whose turn it is ---
            if (!revoteRevealData || !revoteRevealData.active) {
                hideRevealButton();
                document.removeEventListener('keydown', handleRevealKeypress);
                removeGlowFromMySeat();
                return;
            }

            const currentIndex = revoteRevealData.currentIndex || 0;
            const revealOrder = revoteRevealData.revealOrder || [];
            const currentRevealerId = revealOrder[currentIndex];

            console.log('🔄 REVOTE REVEAL: Checking if it\'s my turn');
            console.log('  Current revealer:', currentRevealerId, '  My ID:', currentUser.id);

            if (currentRevealerId === currentUser.id) {
                database.ref(`game/secondVote/votes/${currentUser.id}`).once('value', (voteSnap) => {
                    const votedSeat = voteSnap.val();
                    const alreadyRevealed = revoteRevealData.alreadyRevealed?.[currentUser.id];

                    if (votedSeat && !alreadyRevealed) {
                        console.log('✅ REVOTE REVEAL: Showing reveal button');
                        showRevealButton();
                        document.addEventListener('keydown', handleRevealKeypress);
                        glowMySeat();
                    } else {
                        console.log('⚠️ REVOTE REVEAL: Already revealed or no vote');
                        hideRevealButton();
                        document.removeEventListener('keydown', handleRevealKeypress);
                    }
                });
            } else {
                console.log('❌ REVOTE: Not my turn, hiding button');
                hideRevealButton();
                document.removeEventListener('keydown', handleRevealKeypress);
                removeGlowFromMySeat();
            }
        });
        console.log('✅ Revote reveal listener attached (merged)');
        
        // Enable seat clicking for voting
        enableVotingClicks();

        // Check if this is a revote - apply purple glow to tied seats
        database.ref('game/phase').once('value', (phaseSnap) => {
            if (phaseSnap.val() === 'second-vote') {
                database.ref('game/secondVote/tiedSeats').once('value', (tiedSnap) => {
                    const tiedSeats = tiedSnap.val() || [];
                    
                    console.log('💜 Applying purple glow to tied seats:', tiedSeats);
                    
                    // Glow tied seats purple
                    tiedSeats.forEach(seatNum => {
                        const seat = document.getElementById(`seat-${seatNum}`);
                        if (seat) {
                            seat.style.boxShadow = '0 0 30px 10px rgba(138, 43, 226, 0.8)';
                            seat.style.border = '3px solid #8A2BE2';
                            console.log('💜 Purple glow applied to seat', seatNum);
                        }
                    });
                });
            }
        });
    }

    function exitVoting() {
        console.log('📤 EXITING VOTING PHASE');
        
        // Remove click handlers
        document.querySelectorAll('.video-seat').forEach(seat => {
            seat.style.cursor = 'default';
            seat.onclick = null;
        });

        // Only remove voting listener if NOT going to vote-reveal phase
        database.ref('game/phase').once('value', (snapshot) => {
            const currentPhase = snapshot.val();
            
            // Keep listener active if entering vote-reveal
            if (currentPhase !== 'first-vote-reveal') {
                if (window.votingListener) {
                    database.ref('game/firstVote').off('value', window.votingListener);
                    window.votingListener = null;
                    console.log('✅ Removed voting listener (not in vote-reveal)');
                }
            } else {
                console.log('✅ Keeping voting listener active for vote-reveal phase');
            }
        });
        
        // Disable voting clicks
        disableVotingClicks();
    }

    function enableVotingClicks() {
        console.log('🗳️ Enabling voting clicks on seats');
        
        for (let i = 1; i <= 24; i++) {
            const seat = document.getElementById(`seat-${i}`);
            if (!seat || seat.classList.contains('empty')) continue;
            
            seat.style.cursor = 'pointer';
            seat.dataset.votingClickHandler = 'true';
            seat.onclick = (e) => {
                if (e.target.closest('.seat-label')) return;
                showVoteConfirmation(i);
            };
        }
    } // end _doShowVoteConfirmation

    function disableVotingClicks() {
        console.log('🚫 Disabling voting clicks — restoring seat-selection handlers');
        
        for (let i = 1; i <= 24; i++) {
            const seat = document.getElementById(`seat-${i}`);
            if (!seat) continue;
            
            // Restore to normal seat-selection click (not null) so players can
            // still change seats after voting ends without stale handlers.
            const _seatNum = i;
            seat.onclick = (e) => {
                if (e.target.closest('.seat-label')) return;
                handleSeatClick(_seatNum);
            };
            seat.style.cursor = '';
            delete seat.dataset.votingClickHandler;
        }
    }

    // ============================================
    // VOTE TALLY LISTENERS (HOST ONLY)
    // ============================================

    // Listen for ORIGINAL votes (never cleared) - HOST ONLY
    // DELAYED to ensure seats exist first
    if (currentUser.role === 'host') {
        setTimeout(() => {
            database.ref('game/firstVote/originalVotes').on('value', (snapshot) => {
                const votes = snapshot.val();
                if (votes) {
                    updateVoteTally(votes, 'original-count');
                
                    // Show votes on name tags during voting phase only
                    database.ref('game/phase').once('value', (phaseSnap) => {
                        if (phaseSnap.val() === 'first-vote') {
                            database.ref('game/firstVote/revealed').once('value', (revealedSnapshot) => {
                                if (!revealedSnapshot.val()) {
                                    database.ref('players').once('value', (playersSnapshot) => {
                                        const players = playersSnapshot.val() || {};
                                        
                                        for (let voterId in votes) {
                                            const voterPlayer = players[voterId];
                                            if (voterPlayer && voterPlayer.seat) {
                                                const targetSeat = votes[voterId];
                                                const targetPlayer = Object.values(players).find(p => p.seat === targetSeat);
                                                const targetName = targetPlayer ? targetPlayer.name : `Seat ${targetSeat}`;
                                                
                                                showVoteOnNameTag(voterPlayer.seat, targetName, false);
                                            }
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            });
        }, 2000); // Close setTimeout - wait for seats to generate
        
        // Listen for CURRENT votes (can be cleared during revotes) - HOST ONLY
        database.ref('game/firstVote/votes').on('value', (snapshot) => {
            const votes = snapshot.val();
            console.log('🎯 Host updating vote displays:', votes);
            
            if (votes) {
                updateVoteTally(votes, 'current-count');
                
                // Update host's view of all player votes during voting
                database.ref('game/phase').once('value', (phaseSnap) => {
                    if (phaseSnap.val() === 'first-vote') {
                        database.ref('players').once('value', (playersSnapshot) => {
                            const players = playersSnapshot.val() || {};
                            
                            for (let voterId in votes) {
                                const voter = players[voterId];
                                if (voter && voter.seat) {
                                    const targetSeat = votes[voterId];
                                    const targetPlayer = Object.values(players).find(p => p.seat === targetSeat);
                                    const targetName = targetPlayer ? targetPlayer.name : `Seat ${targetSeat}`;
                                    
                                    showVoteOnNameTag(voter.seat, targetName, false);
                                }
                            }
                        });
                    }
                });
            }
        });
    }

    function showVoteConfirmation(seatNumber) {
        // The pill overlay handles voting — if it's visible, seat clicks do nothing.
        const _pillOverlay = document.getElementById('vote-pill-overlay');
        if (_pillOverlay && _pillOverlay.style.display !== 'none') return;
        // Guard: only fire during an active voting phase.
        database.ref('game/phase').once('value', (_pgSnap) => {
            const _pg = _pgSnap.val() || '';
            if (_pg !== 'first-vote' && _pg !== 'second-vote') {
                console.log('🗳️ showVoteConfirmation: not in voting phase (' + _pg + ') — ignoring stale handler');
                return;
            }
            _doShowVoteConfirmation(seatNumber);
        });
    }
    function _doShowVoteConfirmation(seatNumber) {
        database.ref('game/firstVote/votingLocked').once('value', (snap) => {
            if (snap.val()) {
                alert('Voting is closed');
                return;
            }
            
            // Check if this is a revote
            database.ref('game/phase').once('value', (phaseSnap) => {
                if (phaseSnap.val() === 'second-vote') {
                    // During revote, only allow voting for tied players
                    database.ref('game/secondVote/tiedSeats').once('value', (tiedSnap) => {
                        const tiedSeats = tiedSnap.val() || [];
                        
                        if (!tiedSeats.includes(seatNumber)) {
                            // Get the names of tied players
                            database.ref('players').once('value', (playersSnap) => {
                                const allPlayers = playersSnap.val() || {};
                                const tiedNames = tiedSeats.map(seat => {
                                    const player = Object.values(allPlayers).find(p => p.seat === seat);
                                    return player ? player.name : `Seat ${seat}`;
                                }).join(', ');
                                
                                if (typeof showConfirmation === 'function') {
                                    showConfirmation(
                                        'Revote Restriction',
                                        `You can only vote for players with a purple glow:\n\n${tiedNames}`,
                                        'OK',
                                        () => {} // Do nothing on OK
                                    );
                                } else {
                                    alert(`You can only vote for players who are tied: ${tiedNames}`);
                                }
                            });
                            return;
                        }
                        
                        // Proceed with vote confirmation
                        proceedWithVoteConfirmation(seatNumber);
                    });
                } else {
                    // Normal voting - allow any player
                    proceedWithVoteConfirmation(seatNumber);
                }
            });
        });
    }

    // Helper function to avoid code duplication
    function proceedWithVoteConfirmation(seatNumber) {
        // Get player name
        const targetPlayer = Object.values(gameState.players).find(p => p.seat === seatNumber);
        const playerName = targetPlayer ? targetPlayer.name : `Seat ${seatNumber}`;
        
        if (typeof showConfirmation === 'function') {
            showConfirmation(
                'Confirm Your Vote',
                `Lock in your vote for ${playerName}?`,
                'Lock In',
                () => castVote(seatNumber)
            );
        } else {
            if (confirm(`Lock in your vote for ${playerName}?`)) {
                castVote(seatNumber);
            }
        }
    }

    function castVote(seatNumber, _fromPill) {
        console.log('🗳️ Casting vote for seat:', seatNumber, _fromPill ? '(from pill)' : '');
        
        // Check if voting is still active
        // Skip the active check when called from the pill overlay — the pill
        // is only shown when voting is active, so a double-check just adds a
        // race-condition window where the vote is rejected despite being valid.
        database.ref('game/firstVote').once('value', (snapshot) => {
            const voting = snapshot.val();
            if (!_fromPill && (!voting || !voting.active || voting.votingLocked)) {
                alert('Voting is closed.');
                return;
            }
            
            // Check if this is a revote
            database.ref('game/phase').once('value', (phaseSnap) => {
                const isRevote = phaseSnap.val() === 'second-vote';
                
                const voteUpdates = {};
                
                if (isRevote) {
                    // Store in game/revote/votes
                    voteUpdates['game/secondVote/votes/' + currentUser.id] = seatNumber;
                    voteUpdates['game/secondVote/locked/' + currentUser.id] = true;
                } else {
                    // Store in both current and original for first vote
                    voteUpdates['game/firstVote/votes/' + currentUser.id] = seatNumber;
                    voteUpdates['game/firstVote/originalVotes/' + currentUser.id] = seatNumber;
                    voteUpdates['game/firstVote/locked/' + currentUser.id] = true;
                }
                
                database.ref().update(voteUpdates).then(() => {
                    console.log('✅ Vote recorded for player:', currentUser.id, 'voting for seat:', seatNumber);

                    // Look up target player name then display vote on name tag
                    // AND write autoVoteDisplay so the player sees their own vote
                    // (mirrors what _hostWriteAssignedVote does for host-assigned votes)
                    database.ref('players').once('value', (allPlayersSnap) => {
                        const targetPlayer = Object.values(allPlayersSnap.val() || {}).find(p => p.seat === seatNumber);
                        const targetName = targetPlayer ? targetPlayer.name : ('Seat ' + seatNumber);
                        
                        if (currentUser.role === 'player' && currentUser.seat) {
                            console.log('🎯 Showing vote on player name tag:', currentUser.seat, '→', targetName);
                            // Write autoVoteDisplay so the autoVoteDisplay Firebase listener
                            // triggers showVoteOnNameTag — same path as host-assigned votes.
                            database.ref('game/autoVoteDisplay/' + currentUser.id).set({
                                seat: currentUser.seat,
                                name: targetName
                            });
                            // Also update directly in case listener fires late
                            showVoteOnNameTag(currentUser.seat, targetName, true);
                        }
                    });
                });
            });
        });
    }
    // Expose castVote on window so pill overlay (window scope) can call it
    window.castVote = castVote;

    // ============================================
    // REVOTE PHASE (Stub - to be implemented)
    // ============================================

    function enterRevote() {
        console.log('📥 ENTERING REVOTE PHASE');
        
        // Only players can vote
        if (currentUser.role !== 'player') return;

        // Remove all seat glows from previous phases
        for (let i = 1; i <= 25; i++) {
            const seat = document.getElementById(`seat-${i}`);
            if (seat) {
                seat.style.boxShadow = '';
                seat.style.border = '';
            }
        }
        console.log('🧹 Cleared all seat glows');
        
        // Clear all vote displays from previous round
        for (let i = 1; i <= 25; i++) {
            const nameElement = document.getElementById(`name-${i}`);
            const pronounsElement = document.getElementById(`pronouns-${i}`);
            const seatLabel = nameElement ? nameElement.parentElement : null;
            
            if (nameElement && nameElement.dataset.showingVote) {
                delete nameElement.dataset.showingVote;
                // Reset vote-display styles: if seat is now empty, remove inline
                // styles so CSS defaults apply. If occupied, set player values.
                if (nameElement.textContent === 'Empty') {
                    nameElement.style.fontFamily = '';
                    nameElement.style.fontSize   = '';
                    nameElement.style.color      = '';
                    nameElement.style.textAlign  = '';
                    nameElement.style.visibility = '';
                    nameElement.style.display    = '';
                } else {
                    nameElement.style.fontFamily = 'Arial, sans-serif';
                    nameElement.style.fontSize   = _nameFontSize();
                    nameElement.style.color      = '#fff';
                    nameElement.style.textAlign  = '';
                    nameElement.style.visibility = '';
                    nameElement.style.display    = '';
                }
            }
            if (pronounsElement && pronounsElement.dataset.showingVote) {
                delete pronounsElement.dataset.showingVote;
                pronounsElement.style.display = '';
                // Reset only vote-display styles on pronouns element.
                pronounsElement.style.visibility = '';
                pronounsElement.style.display    = '';
                pronounsElement.style.color      = '';
            }
            if (seatLabel && seatLabel.dataset.showingVote) {
                delete seatLabel.dataset.showingVote;
                // Reset only the background/border set during vote display.
                // Using cssText='' wipes ALL inline styles, causing a layout flash.
                seatLabel.style.background = '';
                seatLabel.style.border = '';
                seatLabel.style.color = '';
                if (seatLabel.parentElement && seatLabel.parentElement.dataset.cotActive)
                    seatLabel.style.visibility = 'hidden';
            }
        }
        
        // Force player display update to restore names
        updatePlayerDisplay();
        
        // Enable voting clicks
        enableVotingClicks();
        
        // Apply purple glow to tied seats
        database.ref('game/secondVote/tiedSeats').once('value', (tiedSnap) => {
            const tiedSeats = tiedSnap.val() || [];
            
            console.log('💜 Revote: Applying purple glow to tied seats:', tiedSeats);
            
            tiedSeats.forEach(seatNum => {
                const seat = document.getElementById(`seat-${seatNum}`);
                if (seat) {
                    seat.style.boxShadow = '0 0 30px 10px rgba(138, 43, 226, 0.8)';
                    seat.style.border = '3px solid #8A2BE2';
                    console.log('💜 Purple glow applied to seat', seatNum);
                }
            });
        });

        // Clear vote displays from name tags
        for (let i = 1; i <= 25; i++) {
            const nameElement = document.getElementById(`name-${i}`);
            const pronounsElement = document.getElementById(`pronouns-${i}`);
            
            if (nameElement && nameElement.dataset.showingVote) {
                delete nameElement.dataset.showingVote;
                // Reset vote-display styles: if seat is now empty, remove inline
                // styles so CSS defaults apply. If occupied, set player values.
                if (nameElement.textContent === 'Empty') {
                    nameElement.style.fontFamily = '';
                    nameElement.style.fontSize   = '';
                    nameElement.style.color      = '';
                    nameElement.style.textAlign  = '';
                    nameElement.style.visibility = '';
                    nameElement.style.display    = '';
                } else {
                    nameElement.style.fontFamily = 'Arial, sans-serif';
                    nameElement.style.fontSize   = _nameFontSize();
                    nameElement.style.color      = '#fff';
                    nameElement.style.textAlign  = '';
                    nameElement.style.visibility = '';
                    nameElement.style.display    = '';
                }
            }
            if (pronounsElement && pronounsElement.dataset.showingVote) {
                delete pronounsElement.dataset.showingVote;
                pronounsElement.style.display = '';
            }
        }
        console.log('🧹 Cleared vote displays from player name tags');
    }

    function exitRevote() {
        console.log('📤 EXITING REVOTE PHASE');

        // Disable voting seat clicks — restore normal seat-selection handlers
        disableVotingClicks();

        // Remove purple glow from tied seats
        for (let i = 1; i <= 25; i++) {
            const seat = document.getElementById(`seat-${i}`);
            if (seat) {
                seat.style.boxShadow = '';
                seat.style.border = '';
            }
        }
        console.log('🧹 exitRevote: cleared purple glow from all seats');

        // If we're heading into second-vote-reveal, keep the voting listener active
        // (same logic as exitVoting keeps it for first-vote-reveal)
        database.ref('game/phase').once('value', (snapshot) => {
            const nextPhase = snapshot.val();
            if (nextPhase !== 'second-vote-reveal') {
                if (window.votingListener) {
                    database.ref('game/firstVote').off('value', window.votingListener);
                    window.votingListener = null;
                    console.log('✅ exitRevote: removed voting listener (not entering second-vote-reveal)');
                }
            } else {
                console.log('✅ exitRevote: keeping voting listener active for second-vote-reveal');
            }
        });
    }

    // ============================================
    // REVOTE REVEAL PHASE (Stub - to be implemented)
    // ============================================

    function enterRevoteReveal() {
        console.log('📥 ENTERING REVOTE REVEAL PHASE');

        // Players only — host UI is driven by its own host.html listeners
        if (currentUser.role !== 'player') return;

        // Clear all seat glows from the revote phase
        for (let i = 1; i <= 25; i++) {
            const seat = document.getElementById(`seat-${i}`);
            if (seat) {
                seat.style.boxShadow = '';
                seat.style.border = '';
            }
        }
        console.log('🧹 enterRevoteReveal: cleared all seat glows');

        // Disable voting clicks — reveal phase is not a voting phase
        disableVotingClicks();

        // Close the vote pill overlay if it was still open
        if (typeof window.closeVotePillOverlay === 'function') {
            window.closeVotePillOverlay();
        }

        // Listen for second-vote-reveal changes to show/update the reveal button.
        // The merged listener at the top of setupFirebaseListeners already handles:
        //   - phase title ("X is revealing their vote")
        //   - purple glow removal
        //   - reveal button show/hide
        // So all we need here is to ensure voting clicks are off and the pill is closed
        // (done above). The module-level secondVoteReveal listener drives the rest.
        console.log('✅ enterRevoteReveal: setup complete — reveal button driven by secondVoteReveal listener');
    }

    function exitRevoteReveal() {
        console.log('📤 EXITING REVOTE REVEAL PHASE');

        // Hide the reveal button and remove keydown handler
        hideRevealButton();
        document.removeEventListener('keydown', handleRevealKeypress);

        // Remove gold glow from all seats (placed during reveal sequence)
        document.querySelectorAll('.video-seat').forEach(seat => {
            seat.style.boxShadow = '';
            seat.style.border = '';
        });
        console.log('🧹 exitRevoteReveal: cleared all seat glows');

        // Remove glow from my own seat specifically
        if (typeof removeGlowFromMySeat === 'function') {
            removeGlowFromMySeat();
        }

        // Remove the big reveal text overlay if it's still on screen
        const bigRevealText = document.getElementById('vote-big-reveal-text');
        if (bigRevealText) bigRevealText.remove();

        // Clear vote displays on name tags — the circle of truth phase starts next
        // and name tags should be clean
        for (let i = 1; i <= 25; i++) {
            const nameEl  = document.getElementById(`name-${i}`);
            const pronEl  = document.getElementById(`pronouns-${i}`);
            const seatEl  = nameEl ? nameEl.parentElement : null;
            if (nameEl && nameEl.dataset.showingVote) {
                delete nameEl.dataset.showingVote;
                nameEl.style.fontFamily = nameEl.textContent === 'Empty' ? '' : 'Arial, sans-serif';
                nameEl.style.fontSize   = nameEl.textContent === 'Empty' ? '' : _nameFontSize();
                nameEl.style.color      = nameEl.textContent === 'Empty' ? '' : '#fff';
                nameEl.style.textAlign  = '';
                nameEl.style.visibility = '';
                nameEl.style.display    = '';
            }
            if (pronEl && pronEl.dataset.showingVote) {
                delete pronEl.dataset.showingVote;
                pronEl.style.visibility = '';
                pronEl.style.display    = '';
                pronEl.style.color      = '';
            }
            if (seatEl && seatEl.dataset.showingVote) {
                delete seatEl.dataset.showingVote;
                seatEl.style.background = '';
                seatEl.style.border     = '';
                seatEl.style.color      = '';
            }
        }
        console.log('🧹 exitRevoteReveal: cleared vote displays from name tags');

        // Force player display refresh to restore names
        updatePlayerDisplay();

        console.log('✅ exitRevoteReveal: cleanup complete');
    }

    // ============================================
    // CIRCLE OF TRUTH PHASE (Enter/Exit)
    // ============================================

    function enterCircleOfTruth() {
        console.log('📥 ENTERING CIRCLE OF TRUTH PHASE');

        // ✅ CLEAR ALL VOTE REVEAL GLOWS
        document.querySelectorAll('.video-seat').forEach(seat => {
            seat.style.boxShadow = '';
            seat.style.border = '';
        });

        console.log('🎯 Setting up Circle of Truth listener');
        console.log('handleCircleUpdate function exists?', typeof handleCircleUpdate);
        
        // Listen for Circle data
        window.circleListener = database.ref('game/circleOfTruth').on('value', handleCircleUpdate);
        
        console.log('✅ Circle listener attached');
        
        // Players also listen for reveal readiness
        if (currentUser.role === 'player' && currentUser.id) {
            console.log('🎯 Setting up reveal ready listener for player');
            window.revealReadyListener = database.ref('players/' + currentUser.id + '/readyToRevealRole')
                .on('value', handleRevealReady);
        }
    }

    function exitCircleOfTruth() {
        console.log('📤 EXITING CIRCLE OF TRUTH PHASE');
            
        // Remove listeners
        if (window.circleListener) {
            database.ref('game/circleOfTruth').off('value', window.circleListener);
            window.circleListener = null;
        }
            
        if (window.revealReadyListener && currentUser.id) {
            database.ref('players/' + currentUser.id + '/readyToRevealRole').off('value', window.revealReadyListener);
            window.revealReadyListener = null;
        }
            
        // Remove spacebar listener
        document.removeEventListener('keydown', handleRoleRevealKeypress);
        window.roleRevealKeypressAdded = false;
            
        // Hide reveal button
        hideRoleRevealButton();
            
        // Remove glow from all seats
        document.querySelectorAll('.video-seat').forEach(seat => {
            seat.style.boxShadow = '';
            seat.style.border = '';
        });

        // Reset seat sizes
        document.querySelectorAll('.video-seat').forEach(seat => {
            seat.style.transform = '';
            seat.style.zIndex = '';
        });
    }

    // ============================================
    // OTHER NECESSITIES
    // ============================================

    // Highlight current revealer's seat with yellow glow
    database.ref('game/firstVote/currentRevealer').on('value', (snapshot) => {
        const currentRevealerId = snapshot.val();
        
        // Remove all existing glows (but preserve purple tie glows during second-vote)
        const _phase1 = window._currentPhase || sessionStorage.getItem('currentPhase') || '';
        document.querySelectorAll('.video-seat').forEach(seat => {
            if (_phase1 === 'second-vote' && seat.style.boxShadow.includes('138, 43, 226')) return;
            seat.style.boxShadow = '';
            seat.style.border = '';
        });
        
        if (!currentRevealerId) return;
        
        // Find and highlight the current revealer's seat
        database.ref('players/' + currentRevealerId).once('value', (playerSnap) => {
            const player = playerSnap.val();
            if (!player || !player.seat) return;
            
            const seatElement = document.getElementById(`seat-${player.seat}`);
            if (seatElement) {
                seatElement.style.boxShadow = '0 0 30px 10px #FFD700';
                seatElement.style.border = '4px solid #FFD700';
                console.log('✨ Highlighting seat', player.seat, 'with yellow glow');
            }
        });
    });

    // Highlight current revealer's seat during SECOND VOTE REVEAL
    database.ref('game/secondVoteReveal').on('value', (snapshot) => {
        const revealData = snapshot.val();
        
        if (!revealData || !revealData.active) return;
        
        // Get current revealer from revealOrder and currentIndex
        const currentIndex = revealData.currentIndex || 0;
        const revealOrder = revealData.revealOrder || [];
        const currentRevealerId = revealOrder[currentIndex];
        
        if (!currentRevealerId) return;
        
        console.log('🔄 REVOTE REVEAL: Current revealer ID:', currentRevealerId);
        
        // Remove all existing glows
        document.querySelectorAll('.video-seat').forEach(seat => {
            seat.style.boxShadow = '';
            seat.style.border = '';
        });
        
        // Find and highlight the current revealer's seat
        database.ref('players/' + currentRevealerId).once('value', (playerSnap) => {
            const player = playerSnap.val();
            if (!player || !player.seat) return;
            
            const seatElement = document.getElementById(`seat-${player.seat}`);
            if (seatElement) {
                seatElement.style.boxShadow = '0 0 30px 10px #FFD700';
                seatElement.style.border = '4px solid #FFD700';
                console.log('✨ REVOTE: Highlighting seat', player.seat, 'with yellow glow');
            }
        });
    });
    
    // Listen to announcements (only show new ones, not old ones)
    database.ref('game/announcement').on('value', (snapshot) => {
        const announcement = snapshot.val();
        if (announcement && announcement.timestamp) {
            const now = Date.now();
            const age = now - announcement.timestamp;
            
            // Only show if announcement is less than 10 seconds old
            if (age < 10000) {
                showAnnouncement(announcement.text);
                
                // Auto-clear announcement after 10 seconds
                setTimeout(() => {
                    database.ref('game/announcement').remove();
                }, 10000);
            }
        }
    });

    // Preserve vote displays AND player info during window resize
    window.addEventListener('resize', () => {
        // Store current displays before resize
        const seatData = {};
        for (let i = 1; i <= 25; i++) {
            const nameElement = document.getElementById(`name-${i}`);
            const pronounsElement = document.getElementById(`pronouns-${i}`);
            
            if (nameElement) {
                seatData[i] = {
                    isShowingVote: nameElement.dataset.showingVote === 'true',
                    votedFor: nameElement.dataset.showingVote ? nameElement.textContent : null,
                    playerName: !nameElement.dataset.showingVote ? nameElement.textContent : null,
                    pronouns: pronounsElement ? pronounsElement.textContent : null
                };
            }
        }
        
        // Restore displays after resize completes
        setTimeout(() => {
            for (let seat in seatData) {
                const data = seatData[seat];
                const nameElement = document.getElementById(`name-${seat}`);
                const pronounsElement = document.getElementById(`pronouns-${seat}`);
                const seatLabel = nameElement ? nameElement.parentElement : null;
                
                if (!nameElement || !seatLabel) continue;
                
                if (data.isShowingVote) {
                    // Restore vote display
                    nameElement.dataset.showingVote = 'true';
                    if (pronounsElement) pronounsElement.dataset.showingVote = 'true';
                    seatLabel.dataset.showingVote = 'true';
                    
                    seatLabel.style.background = '#B2BEB5';
                    if (pronounsElement) {
                        pronounsElement.textContent = '';
                        pronounsElement.style.visibility = 'hidden';
                    }
                    nameElement.textContent = data.votedFor;
                    nameElement.style.fontFamily = "'ShootingStar', cursive";
                    nameElement.style.color = '#fff';
                    nameElement.style.fontSize = '1.3rem';
                } else if (data.playerName && data.playerName !== 'Empty') {
                    // Restore normal player display
                    nameElement.textContent = data.playerName;
                    if (pronounsElement && data.pronouns) {
                        pronounsElement.textContent = data.pronouns;
                        pronounsElement.style.visibility = 'visible';
                    }
                }
            }
        }, 100);
    });

    // Unmute own tracks when a seat is assigned (covers host/prod who are muted
    // until they claim their seat, same as players).
    // Watch for seat assignment to unmute tracks when a player/host claims a seat.
    // The watcher's first fire (immediate, with current Firebase value) is skipped —
    // it represents the existing state, not a new assignment.
    if (currentUser.id) {
        let _seatWatcherFirstFire = true;  // skip the immediate initial fire
        let _prevSeat = null;              // track previous seat to detect genuine changes
        database.ref('players/' + currentUser.id + '/seat').on('value', (seatSnap) => {
            const newSeat = seatSnap.val();
            if (_seatWatcherFirstFire) {
                _seatWatcherFirstFire = false;
                _prevSeat = newSeat; // record initial state without acting on it
                return;
            }
            if (newSeat && !_prevSeat) {
                // Seat was just assigned (went from null → seat value)
                _prevSeat = newSeat;
                const _lkR = window._lkRoom;
                if (_lkR && _lkR.localParticipant) {
                    const _pId = currentUser.id;
                    database.ref('players/' + _pId).once('value', (pSnap) => {
                        const pData = pSnap.val() || {};
                        const _mp = _lkR.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                        const _cp = _lkR.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                        if (_mp) { pData.audioMuted ? _mp.mute() : _mp.unmute(); }
                        if (_cp) { pData.videoMuted  ? _cp.mute()  : _cp.unmute(); }
                        console.log('🔊 Tracks unblocked on seat assignment:', newSeat);
                    });
                }
            } else if (!newSeat) {
                _prevSeat = null; // seat removed — next assignment will unmute again
            } else {
                _prevSeat = newSeat;
            }
        });
    }

    // Show host-assigned votes on this player's own screen.
    // ── Host force-mute / force-camera-off (players only) ──────────────────────────
    // These live in game.js/setupFirebaseListeners so currentUser, database, and
    // LivekitClient are all guaranteed to be initialised.
    if (currentUser.role === 'player' && currentUser.id) {
        function _applyForceMuteGJ(shouldMute) {
            const _r = window._lkRoom;
            if (!_r || _r.state !== 'connected') {
                setTimeout(() => _applyForceMuteGJ(shouldMute), 500); return;
            }
            const _mp = _r.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
            if (!_mp) {
                setTimeout(() => _applyForceMuteGJ(shouldMute), 500); return;
            }
            if (shouldMute) {
                if (!_mp.isMuted) _mp.mute();
                database.ref('players/' + currentUser.id + '/audioMuted').set(true);
                console.log('🔇 game.js: Host force-muted mic via LiveKit');
            } else {
                // Seat guard: don't unmute players who haven't claimed a seat yet —
                // they should stay silent until they formally sit down.
                // The initial Firebase fire (value=false on page load) would otherwise
                // unmute tracks that should stay silent.
                const _hasSeatNow = !!(currentUser.seat || currentUser.roomSeat);
                if (!_hasSeatNow) {
                    console.log('🔇 game.js: Skipping unmute — player has no seat yet');
                    return;
                }
                // Unmute unconditionally — the host clicked 'Unmute All' which means
                // they want everyone unmuted. Don't check hostForcedMute here because
                // the host clears it at the same time as writing muteAllPlayers=false,
                // and Firebase timing means it may not be cleared yet when this fires.
                if (_mp.isMuted) _mp.unmute();
                database.ref('players/' + currentUser.id + '/audioMuted').set(false);
                console.log('🔊 game.js: Host force-unmuted mic via LiveKit');
            }
        }
        database.ref('game/muteAllPlayers').on('value', (snap) => {
            if (snap.val() === null) return;
            _applyForceMuteGJ(!!snap.val());
        });

        // Per-player nightMuted listener (players only).
        // When the host writes nightMuted:true (night/breakfast phase),
        // the player mutes their own LiveKit tracks so they can't be heard/seen.
        // When nightMuted clears (player accepted invite or phase ended),
        // tracks are unmuted automatically.
        if (currentUser.role === 'player' && currentUser.id) {
            let _wasNightMuted = false; // track whether we've ever been night-muted
            database.ref('players/' + currentUser.id + '/nightMuted').on('value', (nmSnap) => {
                const _val = nmSnap.val();
                const _shouldNightMute = !!_val;
                const _r = window._lkRoom;
                const _lp = _r && _r.state === 'connected' && _r.localParticipant;
                const _mp = _lp && _lp.getTrackPublication(LivekitClient.Track.Source.Microphone);
                const _cp = _lp && _lp.getTrackPublication(LivekitClient.Track.Source.Camera);
                if (_shouldNightMute) {
                    _wasNightMuted = true;
                    if (_mp && !_mp.isMuted) _mp.mute();
                    if (_cp && !_cp.isMuted) _cp.mute();
                    // Retry if LiveKit not connected yet — tracks may not be published
                    if (!_lp) {
                        setTimeout(() => {
                            const _r2 = window._lkRoom;
                            const _lp2 = _r2 && _r2.state === 'connected' && _r2.localParticipant;
                            const _mp2 = _lp2 && _lp2.getTrackPublication(LivekitClient.Track.Source.Microphone);
                            const _cp2 = _lp2 && _lp2.getTrackPublication(LivekitClient.Track.Source.Camera);
                            if (_mp2 && !_mp2.isMuted) _mp2.mute();
                            if (_cp2 && !_cp2.isMuted) _cp2.mute();
                            console.log('🌙 nightMuted retry: tracks silenced');
                        }, 2000);
                    }
                    console.log('🌙 nightMuted: tracks silenced');
                } else if (_wasNightMuted && (_val === null || _val === false)) {
                    // nightMuted was cleared (host ended night/breakfast, or player accepted invite)
                    _wasNightMuted = false;
                    if (_mp && _mp.isMuted) _mp.unmute();
                    if (_cp && _cp.isMuted) _cp.unmute();
                    console.log('🌙 nightMuted cleared: tracks restored');
                }
            });
        }

        // Per-player host-forced mic mute listener
        // When host mutes an individual player's mic, this fires on their device
        // and directly mutes/unmutes the LiveKit mic track.
        if (currentUser.role === 'player' && currentUser.id) {
            database.ref('players/' + currentUser.id + '/hostForcedMic').on('value', (hfSnap) => {
                const _forced = hfSnap.val();
                if (_forced === null) return; // field not set — no action
                const _r = window._lkRoom;
                const _lp = _r && _r.state === 'connected' && _r.localParticipant;
                const _mp = _lp && _lp.getTrackPublication(LivekitClient.Track.Source.Microphone);
                if (_mp) {
                    if (_forced && !_mp.isMuted) {
                        _mp.mute();
                        console.log('🎤 Host force-muted mic');
                    } else if (!_forced && _mp.isMuted) {
                        _mp.unmute();
                        console.log('🎤 Host force-unmuted mic');
                    }
                } else if (_forced) {
                    // LiveKit not connected yet — retry
                    setTimeout(() => {
                        const _r2 = window._lkRoom;
                        const _lp2 = _r2 && _r2.state === 'connected' && _r2.localParticipant;
                        const _mp2 = _lp2 && _lp2.getTrackPublication(LivekitClient.Track.Source.Microphone);
                        if (_mp2 && !_mp2.isMuted) _mp2.mute();
                    }, 1500);
                }
            });

            // Per-player host-forced camera mute listener
            database.ref('players/' + currentUser.id + '/hostForcedCam').on('value', (hfcSnap) => {
                const _forcedCam = hfcSnap.val();
                if (_forcedCam === null) return;
                const _r = window._lkRoom;
                const _lp = _r && _r.state === 'connected' && _r.localParticipant;
                const _cp = _lp && _lp.getTrackPublication(LivekitClient.Track.Source.Camera);
                if (_cp) {
                    if (_forcedCam && !_cp.isMuted) {
                        _cp.mute();
                        console.log('📹 Host force-muted camera');
                    } else if (!_forcedCam && _cp.isMuted) {
                        _cp.unmute();
                        console.log('📹 Host force-unmuted camera');
                    }
                } else if (_forcedCam) {
                    setTimeout(() => {
                        const _r2 = window._lkRoom;
                        const _lp2 = _r2 && _r2.state === 'connected' && _r2.localParticipant;
                        const _cp2 = _lp2 && _lp2.getTrackPublication(LivekitClient.Track.Source.Camera);
                        if (_cp2 && !_cp2.isMuted) _cp2.mute();
                    }, 1500);
                }
            });
        }

        function _applyForceCamGJ(camerasOff) {
            const _r = window._lkRoom;
            if (!_r || _r.state !== 'connected') {
                setTimeout(() => _applyForceCamGJ(camerasOff), 500); return;
            }
            const _cp = _r.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
            if (!_cp) {
                setTimeout(() => _applyForceCamGJ(camerasOff), 500); return;
            }
            if (camerasOff) {
                if (!_cp.isMuted) _cp.mute();
                database.ref('players/' + currentUser.id + '/videoMuted').set(true);
                console.log('📵 game.js: Host force-disabled camera via LiveKit');
            } else {
                // Same seat guard as mic: don't re-enable camera for unseated players.
                const _hasSeatNow = !!(currentUser.seat || currentUser.roomSeat);
                if (!_hasSeatNow) {
                    console.log('📵 game.js: Skipping camera-enable — player has no seat yet');
                    return;
                }
                if (_cp.isMuted) _cp.unmute();
                database.ref('players/' + currentUser.id + '/videoMuted').set(false);
                console.log('📹 game.js: Host force-enabled camera via LiveKit');
            }
        }
        database.ref('game/camerasOffPlayers').on('value', (snap) => {
            if (snap.val() === null) return;
            _applyForceCamGJ(!!snap.val());
        });
    }

    // Must be inside setupFirebaseListeners() — currentUser.id is guaranteed set here.
    if (currentUser.id) {
        database.ref('game/autoVoteDisplay/' + currentUser.id).on('value', (snapshot) => {
            const data = snapshot.val();
            if (!data || currentUser.role !== 'player') return;
            // Check if the seat DOM element already exists
            const seatEl = document.getElementById('name-' + data.seat);
            if (seatEl) {
                // Seat exists — display immediately and clear the stale value
                showVoteOnNameTag(data.seat, data.name, true);
                _applyPillHostChange(data);
                database.ref('game/autoVoteDisplay/' + currentUser.id).remove();
            } else {
                // Seats not generated yet — wait for them then display
                const _waitForSeat = setInterval(() => {
                    if (document.getElementById('name-' + data.seat)) {
                        clearInterval(_waitForSeat);
                        // Re-read to make sure value wasn't cleared in the meantime
                        database.ref('game/autoVoteDisplay/' + currentUser.id).once('value', (snap) => {
                            const d = snap.val();
                            if (d && currentUser.role === 'player') {
                                showVoteOnNameTag(d.seat, d.name, true);
                                _applyPillHostChange(d);
                                database.ref('game/autoVoteDisplay/' + currentUser.id).remove();
                            }
                        });
                    }
                }, 200);
                // Safety: stop polling after 30 s to avoid leak
                setTimeout(() => clearInterval(_waitForSeat), 30000);
            }
        });
    }
}

// TEST: Verify functions are global
console.log('🧪 Testing global function availability:');
console.log('showVoteOnNameTag:', typeof showVoteOnNameTag);
console.log('updateVoteTally:', typeof updateVoteTally);
console.log('handleCircleUpdate:', typeof handleCircleUpdate);
console.log('revealMyVote:', typeof revealMyVote);
console.log('revealRole:', typeof revealRole);

// ============================================
// VOTE DISPLAY HELPER FUNCTIONS (GLOBAL)
// ============================================

// Helper: returns true if the current phase is a vote reveal phase.
// Used by viewer mode logic to allow vote display during reveals.
window._isRevealPhase = function() {
    const phase = window._currentPhase
        || sessionStorage.getItem('currentPhase')
        || '';
    // Phase-name based reveals (first-vote-reveal, second-vote-reveal etc.)
    if (phase.includes('reveal') || phase === 'circle-of-truth') return true;
    // End-game reveals set a global flag when banishment/smoke reveals are active
    if (window._endGameRevealActive) return true;
    return false;
};

function showVoteOnNameTag(seatNumber, votedForName, playerView) {
    // Viewer mode guard: host/prod members cannot see votes on name boxes
    // UNLESS the current phase is an explicit reveal phase.
    const _isHostOrProd = currentUser && (currentUser.role === 'host' || currentUser.isProdMember
        || currentUser.role === 'observer');
    if (_isHostOrProd && localStorage.getItem('viewerModeEnabled') === 'true') {
        // Only allow name-box vote display during reveal phases (by phase name)
        const _ph = (window._currentPhase || sessionStorage.getItem('currentPhase') || '').toLowerCase();
        const _revealPhases = [
            'first-vote-reveal', 'second-vote-reveal',
            'smoke-vote-reveal', 'banishment-reveal', 'banishment-tie-reveal',
            'circle-of-truth'
        ];
        // Also allow during end-game reveals (banishment/smoke) when explicitly flagged
        const _endGameReveal = window._endGameRevealActive === true;
        const _isReveal = _revealPhases.some(r => _ph.includes(r)) || _ph.includes('reveal') || _endGameReveal;
        if (!_isReveal) {
            console.log('👁️ Viewer mode: suppressing vote display on name tag (phase:', _ph, ')');
            return;
        }
    }
    console.log('showVoteOnNameTag called:', {seatNumber, votedForName, playerView, currentUserRole: currentUser.role});

    const nameElement = document.getElementById(`name-${seatNumber}`);
    const pronounsElement = document.getElementById(`pronouns-${seatNumber}`);
    const seatLabel = nameElement ? nameElement.parentElement : null;
    
    if (!nameElement || !pronounsElement || !seatLabel) {
        console.error('Name tag elements not found for seat', seatNumber);
        return;
    }

    console.log('✅ Found name tag elements for seat', seatNumber);
    
    // Mark elements to prevent overwriting
    nameElement.dataset.showingVote = 'true';
    pronounsElement.dataset.showingVote = 'true';
    seatLabel.dataset.showingVote = 'true';
    
    // Change background color
    seatLabel.style.background = '#B2BEB5';
    
    // Keep pronouns element visible but empty
    pronounsElement.textContent = '';
    pronounsElement.style.visibility = 'hidden'; // Keep space but hide text
    
    // Set all styles EXCEPT display
    nameElement.style.fontFamily = "'ShootingStar', cursive";
    nameElement.style.color = '#fff';
    nameElement.style.fontSize = '1.3rem';
    nameElement.style.textAlign = 'center';
    nameElement.style.visibility = 'hidden'; // Hide but keep space
    nameElement.style.display = 'block';

    // Set the text
    nameElement.textContent = votedForName;

    // Wait for ShootingStar font to load, then show
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
            document.fonts.load("1.3rem 'ShootingStar'").then(() => {
                nameElement.style.visibility = 'visible';
                console.log('✅ Vote displayed with font loaded');
            }).catch(() => {
                // Fallback if font fails to load
                nameElement.style.visibility = 'visible';
                console.warn('⚠️ Font load failed, showing anyway');
            });
        });
    } else {
        // Fallback for older browsers
        setTimeout(() => {
            nameElement.style.visibility = 'visible';
        }, 50);
    }
    
    console.log('✅ Vote displayed on seat', seatNumber, '→', votedForName);
}

function updateVoteTally(votes, targetElement = 'original-count') {
    // Note: tally always updates in background; section visibility is controlled
    // by hideRealtimeVoteDisplays/showRealtimeVoteDisplays for viewer mode.
    console.log('📊 updateVoteTally called with:', votes, 'target:', targetElement);
    console.log('Current user role:', currentUser.role);

    const contentElement = document.getElementById(targetElement);
    
    if (!contentElement) {
        console.log(targetElement + ' element not found');
        return;
    }
    
    console.log('Updating vote tally with votes:', votes);
    
    // Count votes per seat
    const voteCounts = {};
    for (let voterId in votes) {
        const targetSeat = votes[voterId];
        voteCounts[targetSeat] = (voteCounts[targetSeat] || 0) + 1;
    }
    
    console.log('Vote counts:', voteCounts);
    
    // Display tally
    if (Object.keys(voteCounts).length === 0) {
        contentElement.innerHTML = '<div style="color: #666;">No votes cast yet</div>';
        return;
    }
    
    contentElement.innerHTML = '';
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
    let colorIndex = 0;
    
    for (let seat in voteCounts) {
        const player = Object.values(gameState.players).find(p => p.seat === parseInt(seat));
        const name = player ? player.name : seat;
        const count = voteCounts[seat];
        const color = colors[colorIndex % colors.length];
        
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 10px;
            margin: 5px 0;
            background: rgba(255,255,255,0.1);
            border-radius: 5px;
            color: ${color};
            font-weight: bold;
        `;
        item.textContent = `${name}: ${count} vote${count > 1 ? 's' : ''}`;
        contentElement.appendChild(item);
        
        colorIndex++;
    }
}

// ============================================
// VOTE REVEAL HELPER FUNCTIONS (GLOBAL)
// ============================================

function showRevealButton() {
    let revealBtn = document.getElementById('my-reveal-button');
    
    if (!revealBtn) {
        revealBtn = document.createElement('button');
        revealBtn.id = 'my-reveal-button';
        revealBtn.className = 'control-button primary';
        revealBtn.textContent = 'Reveal Vote';
        revealBtn.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            padding: 12px 24px;
            font-size: 1rem;
            z-index: 200;
            white-space: nowrap;
            background: #4CAF50;
            border: 2px solid #45a049;
        `;
        revealBtn.onclick = revealMyVote;
        document.body.appendChild(revealBtn);
    }
    
    revealBtn.style.display = 'block';
}

// ──────────────────────────────────────────────────────────────────────
// VOTE PILL OVERLAY — shown during first-vote and second-vote phases
// ──────────────────────────────────────────────────────────────────────
window._pillSelectedSeat = null;

window.showVotePillOverlay = function(isRevote) {
    // If player already has a selection pending (hasn't locked in yet),
    // don't rebuild the overlay — it would wipe their selection.
    if (window._pillSelectedSeat && !window.votePillLocked) {
        console.log('🗳️ showVotePillOverlay: skipping rebuild — pending selection for seat', window._pillSelectedSeat);
        return;
    }
    // Build list of eligible players to vote for
    database.ref('players').once('value', (pSnap) => {
        const allPlayers = pSnap.val() || {};
        let eligible = Object.values(allPlayers).filter(pl =>
            pl.seat && !pl.isHost && !pl.isProdMember &&
            pl.id !== currentUser.id &&       // can't vote for self (by id)
            pl.seat !== currentUser.seat       // belt-and-suspenders: also exclude by seat
        );

        if (isRevote) {
            // Revote: only show tied players
            database.ref('game/secondVote/tiedSeats').once('value', (tSnap) => {
                const tied = tSnap.val() || [];
                eligible = eligible.filter(pl => tied.includes(pl.seat));
                _buildPillOverlay(eligible, isRevote);
            });
        } else {
            _buildPillOverlay(eligible, isRevote);
        }
    });
};

function _buildPillOverlay(eligible, isRevote) {
    const overlay  = document.getElementById('vote-pill-overlay');
    const title    = document.getElementById('vote-pill-title');
    const subtitle = document.getElementById('vote-pill-subtitle');
    const btnCont  = document.getElementById('vote-pill-buttons');
    const selEl    = document.getElementById('vote-pill-selection');
    const lockBtn  = document.getElementById('vote-pill-lock-btn');
    const lockedMsg= document.getElementById('vote-pill-locked-msg');
    if (!overlay) return;

    // Reset state
    window._pillSelectedSeat = null;
    window.votePillLocked = false;
    if (title)    title.textContent    = isRevote ? '🗳️ Revote' : '🗳️ Cast Your Vote';
    if (subtitle) subtitle.textContent = isRevote
        ? 'Only tied players are shown. Select one to vote.'
        : 'Select a player to vote for, then lock in.';
    if (selEl)    selEl.textContent    = '';
    if (lockedMsg) {
        lockedMsg.style.display = 'none';
        lockedMsg.textContent   = '✅ Vote locked in! Waiting for reveal...';
        lockedMsg.style.color   = '#4CAF50'; // restore default green
    }
    if (lockBtn) { lockBtn.style.opacity = '0.4'; lockBtn.style.pointerEvents = 'none'; }
    if (btnCont)  btnCont.innerHTML    = '';

    eligible.sort((a, b) => (a.seat || 0) - (b.seat || 0));
    eligible.forEach(pl => {
        const btn = document.createElement('button');
        btn.dataset.seat = pl.seat;
        btn.textContent  = pl.name || ('Seat ' + pl.seat);
        btn.style.cssText = 'padding:14px 22px; font-size:1.1rem; font-weight:bold;' +
            ' background:rgba(220,20,60,0.15); border:2px solid rgba(220,20,60,0.5);' +
            ' border-radius:10px; color:white; cursor:pointer; min-width:120px; transition:all 0.15s;';
        btn.onclick = () => {
            if (window.votePillLocked) return;
            window._pillSelectedSeat = pl.seat;
            // Highlight selected
            btnCont.querySelectorAll('button').forEach(b => {
                b.style.background = 'rgba(220,20,60,0.15)';
                b.style.borderColor = 'rgba(220,20,60,0.5)';
            });
            btn.style.background  = 'rgba(220,20,60,0.6)';
            btn.style.borderColor = '#DC143C';
            if (selEl) selEl.textContent = 'Voting for: ' + btn.textContent;
            if (lockBtn) { lockBtn.style.opacity = '1'; lockBtn.style.pointerEvents = 'auto'; }
        };
        if (btnCont) btnCont.appendChild(btn);
    });

    overlay.style.display = 'flex';
}

window.lockInPillVote = function() {
    if (!window._pillSelectedSeat || window.votePillLocked) return;
    window.votePillLocked = true;
    const lockBtn   = document.getElementById('vote-pill-lock-btn');
    const lockedMsg = document.getElementById('vote-pill-locked-msg');
    if (lockBtn)   { lockBtn.style.opacity = '0.4'; lockBtn.style.pointerEvents = 'none'; }
    if (lockedMsg)   lockedMsg.style.display = 'block';
    window.castVote(window._pillSelectedSeat, true); // true = fromPill, skip active guard
};

// Called when host assigns/changes a player's vote.
// Updates whichever voting pill overlay is currently open.
function _applyPillHostChange(data) {
    if (!data || !data.changedBy) return; // player's own vote — no change needed
    // Detect which overlay is open: regular vote or banishment
    const _banishOverlay = document.getElementById('banishment-vote-overlay');
    const _banishOpen = _banishOverlay && _banishOverlay.style.display === 'flex';
    if (_banishOpen) {
        // Update banishment overlay
        const _bDisplay = document.getElementById('banishment-vote-display');
        const _bMsg     = document.getElementById('banishment-locked-msg');
        const _bLock    = document.getElementById('banishment-lock-btn');
        const _bPills   = document.getElementById('banishment-player-pills');
        if (_bPills) _bPills.querySelectorAll('button').forEach(btn => {
            const isNew = btn.dataset.name === data.name;
            btn.style.background   = isNew ? 'rgba(220,20,60,0.5)' : 'rgba(220,20,60,0.15)';
            btn.style.borderWidth  = isNew ? '3px' : '2px';
        });
        if (_bDisplay) _bDisplay.textContent = 'Voting to banish: ' + data.name;
        if (_bLock)    _bLock.disabled = true;
        if (_bMsg) {
            _bMsg.textContent    = data.changedBy + ' changed your vote to ' + data.name + '.';
            _bMsg.style.display  = 'block';
            _bMsg.style.color    = '#FFD700';
        }
        return;
    }
    const overlay  = document.getElementById('vote-pill-overlay');
    if (!overlay || overlay.style.display === 'none') return; // overlay not open

    const btnCont  = document.getElementById('vote-pill-buttons');
    const selEl    = document.getElementById('vote-pill-selection');
    const lockedMsg= document.getElementById('vote-pill-locked-msg');
    const lockBtn  = document.getElementById('vote-pill-lock-btn');

    // Find which pill button matches the new target name
    if (btnCont) {
        btnCont.querySelectorAll('button').forEach(btn => {
            const isNew = btn.textContent === data.name;
            btn.style.background  = isNew ? 'rgba(220,20,60,0.6)' : 'rgba(220,20,60,0.15)';
            btn.style.borderColor = isNew ? '#DC143C'              : 'rgba(220,20,60,0.5)';
        });
    }

    // Update selection display
    if (selEl) selEl.textContent = 'Voting for: ' + data.name;

    // Lock the overlay (vote is now locked in by host)
    window.votePillLocked = true;
    window._pillSelectedSeat = data.seat || null; // record the new target seat
    if (lockBtn) { lockBtn.style.opacity = '0.4'; lockBtn.style.pointerEvents = 'none'; }

    // Show changed-by message
    if (lockedMsg) {
        lockedMsg.textContent = data.changedBy + ' changed your vote to ' + data.name + '.';
        lockedMsg.style.display = 'block';
        lockedMsg.style.color = '#FFD700'; // gold to distinguish from normal lock-in
    }
}

window.closeVotePillOverlay = function() {
    const overlay = document.getElementById('vote-pill-overlay');
    if (overlay) overlay.style.display = 'none';
    window._pillSelectedSeat = null;
    window.votePillLocked = false;
};

function hideRevealButton() {
    const btn = document.getElementById('my-reveal-button');
    if (btn) btn.remove();
}

function handleRevealKeypress(e) {
    if (e.code === 'Space') {
        e.preventDefault();
        console.log('🎯 SPACEBAR - Revealing vote');
        console.log('🎯 About to call revealMyVote');
        console.log('🎯 typeof revealMyVote:', typeof revealMyVote);
        try {
            revealMyVote();
            console.log('🎯 revealMyVote() called successfully');
        } catch (err) {
            console.error('🎯 ERROR calling revealMyVote:', err);
        }
    }
}

function glowMySeat() {
    const mySeat = document.getElementById(`seat-${currentUser.seat}`);
    if (mySeat) {
        mySeat.style.boxShadow = '0 0 30px 10px #FFD700';
        mySeat.style.border = '3px solid #FFD700';
    }
}

function removeGlowFromMySeat() {
    const mySeat = document.getElementById(`seat-${currentUser.seat}`);
    if (mySeat) {
        mySeat.style.boxShadow = '';
        mySeat.style.border = '';
    }
}

function showCurrentRevealerName(revealerSeat) {
    console.log('👤 Showing revealer name for seat:', revealerSeat);
    
    // Find the player by their seat number
    const player = Object.values(gameState.players).find(p => p.seat === revealerSeat);
    
    if (!player) {
        console.error('❌ Player not found for seat:', revealerSeat);
        return;
    }
    
    console.log('✅ Found player:', player.name);
    
    // Update phase title with correct selector
    const phaseTitle = document.getElementById('phase-name');
    
    if (phaseTitle) {
        phaseTitle.textContent = `${player.name} is revealing their vote.`;
        console.log('✅ Updated phase title to:', phaseTitle.textContent);
    } else {
        console.warn('⚠️ Phase title element not found. Checked: .phase-name, #phase-name, h1, .game-phase');
    }
}

function revealMyVote() {
    console.log('📣 📣 📣 REVEALYMVOTE CALLED - TOP OF FUNCTION');
    console.log('📣 currentUser:', currentUser);
    console.log('📣 database:', database);
    
    try {
        console.log('📣 Inside try block');
        // Check if we're in revote reveal mode
        database.ref('game/secondVoteReveal').once('value', (revoteRevealSnap) => {
            try {
                const revoteRevealData = revoteRevealSnap.val();
                const isRevoteReveal = revoteRevealData && revoteRevealData.active;
                
                console.log('🔍 Reveal mode check - isRevoteReveal:', isRevoteReveal);
                
                // Determine which vote path to use
                const votePath = isRevoteReveal ? 'game/secondVote/votes' : 'game/firstVote/votes';
                const revealPath = isRevoteReveal ? 'game/secondVoteReveal/revealedVotes' : 'game/revealedVoteDisplay';
                
                console.log('📍 Using vote path:', votePath);
                console.log('📍 Using reveal path:', revealPath);
                
                // Get my vote
                database.ref(votePath).once('value', (votesSnap) => {
                    try {
                        const allVotes = votesSnap.val() || {};
                        const votedSeat = allVotes[currentUser.id];
                        
                        console.log('🗳️ All votes:', allVotes);
                        console.log('🗳️ My vote (seat):', votedSeat);
                        
                        if (!votedSeat) {
                            console.error('❌ No vote found for current user!');
                            return;
                        }
                        
                        // Get the name of the player I voted for
                        database.ref('players').once('value', (playersSnap) => {
                            try {
                                const players = playersSnap.val() || {};
                                const targetPlayer = Object.values(players).find(p => p.seat === votedSeat);
                                const targetName = targetPlayer ? targetPlayer.name : `Seat ${votedSeat}`;
                                
                                console.log('👤 Target player:', targetPlayer);
                                console.log('👤 Target name:', targetName);
                                
                                // Write reveal to Firebase
                                const revealData = {
                                    seat: currentUser.seat,
                                    name: currentUser.name,
                                    votedFor: targetName,
                                    timestamp: Date.now()
                                };
                                
                                console.log('💾 About to write reveal data:', revealData);
                                console.log('💾 To path:', revealPath + '/' + currentUser.id);
                                
                                database.ref(revealPath + '/' + currentUser.id).set(revealData).then(() => {
                                    console.log('✅ Vote revealed successfully:', {
                                        path: revealPath + '/' + currentUser.id,
                                        seat: currentUser.seat,
                                        name: currentUser.name,
                                        votedFor: targetName
                                    });
                                    
                                    // Mark as already revealed
                                    const alreadyRevealedPath = isRevoteReveal 
                                        ? 'game/secondVoteReveal/alreadyRevealed/' + currentUser.id
                                        : 'game/firstVote/alreadyRevealed/' + currentUser.id;
                                    
                                    database.ref(alreadyRevealedPath).set(true);
                                    hideRevealButton();
                                    removeGlowFromMySeat();
                                }).catch(err => {
                                    console.error('❌ Error writing reveal to Firebase:', err);
                                });
                            } catch (err) {
                                console.error('❌ Error in players callback:', err);
                            }
                        });
                    } catch (err) {
                        console.error('❌ Error in votes callback:', err);
                    }
                });
            } catch (err) {
                console.error('❌ Error in secondVoteReveal callback:', err);
            }
        });
    } catch (err) {
        console.error('❌ Error in revealMyVote:', err);
    }
}

// updateRevealedVotesDisplay() — REMOVED (dead code).
// This function read from 'game/voteReveal', a path that is never written to
// anywhere in the codebase. It was never called (zero call sites exist).
// The actual vote reveal display is handled by the two listeners below:
//   Line ~4682: game/revealedVoteDisplay child_added → showVoteOnNameTag + big reveal text
//   Line ~4702: game/revealedVoteDisplay value → host tally (reveal-count element)
//   Line ~4752: game/revealedVoteDisplay value → player tally (first-vote-tally-content element)

// ============================================
// CIRCLE OF TRUTH PHASE (GLOBAL)
// ============================================

// Track the last CoT seat so we can always reset it even if Firebase is cleared
window._lastCotSeat = null;

function _resetCotSeat(seatNumber) {
    if (!seatNumber) return;
    const seat = document.getElementById('seat-' + seatNumber);
    if (seat) {
        seat.style.transition = 'transform 0.5s ease';
        seat.style.transform = 'translate(-50%, -50%)';
        seat.style.removeProperty('z-index');
        delete seat.dataset.cotActive;
        const label = seat.querySelector('.seat-label') || seat.querySelector('[class*="label"]');
        if (label) { label.style.visibility = ''; label.style.transform = ''; label.style.transformOrigin = ''; }
    }
    // Restore all other seats' z-index — remove the important override
    for (let _i = 1; _i <= 25; _i++) {
        const _s = document.getElementById('seat-' + _i);
        if (_s) _s.style.removeProperty('z-index');
    }
    window._lastCotSeat = null;
    console.log('🔄 CoT seat', seatNumber, 'reset to normal size');
}

function handleCircleUpdate(snapshot) {
    const data = snapshot.val();
    
    console.log('🔍 Circle update received:', data);
    
    if (!data || !data.active) {
        console.log('❌ Circle of Truth not active — resetting seat size');
        // Reset whichever seat was last enlarged
        const seatToReset = (data && data.seatNumber) || window._lastCotSeat;
        _resetCotSeat(seatToReset);
        return;
    }
    
    console.log('🎯 Circle of Truth active for seat:', data.seatNumber);
    window._lastCotSeat = data.seatNumber;
    
    // Enlarge the selected player's seat FOR EVERYONE
    const seat = document.getElementById(`seat-${data.seatNumber}`);
    
    if (!seat) {
        console.error('❌ Seat element not found:', `seat-${data.seatNumber}`);
        return;
    }
    
    console.log('📏 Applying transform to seat', data.seatNumber);
    
    // Set all OTHER seats to a low z-index. The CSS has z-index:50 !important,
    // so we must use setProperty with 'important' flag to override it.
    for (let i = 1; i <= 25; i++) {
        if (i !== data.seatNumber) {
            const otherSeat = document.getElementById(`seat-${i}`);
            if (otherSeat) {
                otherSeat.style.setProperty('z-index', '1', 'important');
                otherSeat.style.transform = 'translate(-50%, -50%)';
                const otherLabel = otherSeat.querySelector('.seat-label');
                if (otherLabel) otherLabel.style.transform = '';
            }
        }
    }
    
    // Apply CoT seat — z-index 1000 !important beats CSS z-index:50 !important
    // (later-declared inline important wins when specificity is equal)
    seat.style.transition = 'transform 0.5s ease';
    seat.style.transform = 'translate(-50%, -50%) scale(2.0)';
    seat.style.setProperty('z-index', '1000', 'important');
    
    // Hide the name label while the seat is enlarged for CoT.
    // A scaled child label overflows the seat and can appear in front of neighboring seats.
    // Hiding it is the cleanest solution — the user confirmed this is acceptable.
    const _cotLabel = seat.querySelector('.seat-label') || seat.querySelector('[class*="label"]');
    if (_cotLabel) _cotLabel.style.visibility = 'hidden';
    seat.dataset.cotActive = 'true';
    
    console.log('✅ Enlarged seat', data.seatNumber, 'with z-index 1000 above all neighbours');
}

function handleRevealReady(snapshot) {
    console.log('🔔 readyToRevealRole changed:', snapshot.val());
        
    if (snapshot.val() === true) {
        console.log('✅ Showing role reveal button!');
        showRoleRevealButton();
            
        // Add spacebar listener (only once)
        if (!window.roleRevealKeypressAdded) {
            document.addEventListener('keydown', handleRoleRevealKeypress);
            window.roleRevealKeypressAdded = true;
        }
    }
}

function handleRoleRevealKeypress(e) {
    if (e.code === 'Space') {
        e.preventDefault();
        console.log('⌨️ Spacebar pressed for role reveal');
        revealRole();
    }
}

function showRoleRevealButton() {
    let btn = document.getElementById('role-reveal-btn');
    if (!btn) {
        console.log('➕ Creating role reveal button');
        btn = document.createElement('button');
        btn.id = 'role-reveal-btn';
        btn.textContent = 'Reveal Role (SPACE)';
        btn.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            padding: 15px 30px;
            background: #DC143C;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 1.2rem;
            font-weight: bold;
            cursor: pointer;
            z-index: 1000;
            box-shadow: 0 5px 20px rgba(0,0,0,0.3);
        `;
        btn.onclick = revealRole;
        document.body.appendChild(btn);
        console.log('✅ Role reveal button added to page');
    }
}

function hideRoleRevealButton() {
    const btn = document.getElementById('role-reveal-btn');
    if (btn) {
        btn.remove();
        console.log('🗑️ Role reveal button removed');
    }
}

function revealRole() {
    console.log('🎭 Revealing role!');
        
    database.ref('game/circleOfTruth').once('value', (snapshot) => {
        const data = snapshot.val();
            
        if (!data) {
            console.error('❌ No Circle of Truth data found');
            return;
        }
        
        // Get the role from the player's Firebase data (assigned by host)
        database.ref('players/' + currentUser.id + '/role').once('value', (roleSnap) => {
            const playerRole = roleSnap.val();
            
            if (!playerRole) {
                console.error('❌ Player has no role assigned');
                return;
            }
            
            // Trigger role reveal
            database.ref('game/roleReveal').set({
                role: playerRole,
                playerId: data.playerId,
                seatNumber: data.seatNumber,
                timestamp: Date.now()
            });
                
            hideRoleRevealButton();
                
            // Remove readyToRevealRole flag
            database.ref('players/' + currentUser.id + '/readyToRevealRole').set(false);
        });
    });
}

// ============================================
// PHASE HANDLING
// ============================================
    
    // Handle phase-specific UI changes
    function handlePhaseChange(phase) {
        console.log('Phase changed to:', phase);
        gameState.phase = phase; // Update gameState
        window._currentPhase = phase; // Keep global in sync for updateSeatDisplay
        
        // Force phase element update immediately
        const phaseElement = document.getElementById('phase-name');
        if (phaseElement && phase) {
            const phaseNames = {
                'lobby': 'Lobby - Select Your Seat',
                'breakfast': 'Breakfast',
                'talk': 'Talk Time',
                'deliberation': 'Roundtable',
                'first-vote': 'Voting Phase',
                'first-vote-reveal': 'Vote Reveal',
                'second-vote': 'Revote Phase',
                'circle-of-truth': 'Circle of Truth',
                'night': 'Night'
            };
            if (phaseNames[phase]) {
                phaseElement.textContent = phaseNames[phase];
            }
        }
        
        // Update body class for phase-specific overlay
        document.body.className = ''; // Clear all phase classes
        // Sanitize phase for use as CSS class (phase can contain spaces/punctuation)
        const _safePhase = phase.replace(/[^a-zA-Z0-9-_]/g, '-');
        document.body.classList.add(`phase-${_safePhase}`);
        
        // Handle night phase overlay
        if (phase === 'night') {
            showNightOverlay();
            
            // For PLAYERS, hide all seats during night phase
            if (currentUser.role === 'player') {
                console.log('Night phase - hiding seats for player');
                document.querySelectorAll('.video-seat').forEach(seat => {
                    seat.style.setProperty('display', 'none', 'important');
                    seat.style.setProperty('visibility', 'hidden', 'important');
                });
                const tabContainer = document.querySelector('.tab-container');
                if (tabContainer) {
                    tabContainer.style.setProperty('display', 'none', 'important');
                    tabContainer.style.setProperty('visibility', 'hidden', 'important');
                }
            }
            
            // Send all non-host, non-turret players to waiting room
            if (currentUser.role === 'host') {
                // Keep players in their seats during night — the overlay hides them visually.
                // Just mark them as night-muted so their audio/video are silenced.
                // Seats and room assignments are preserved so re-entry is instant.
                database.ref('players').once('value', (snapshot) => {
                    snapshot.forEach((child) => {
                        const player = child.val();
                        if (child.key !== 'host' && player.room !== 'turret' && !player.isProdMember) {
                            // Clear seat and move to waiting — mute audio/video
                            const _nu = {};
                            _nu['players/' + child.key + '/room'] = 'waiting';
                            _nu['players/' + child.key + '/seat'] = null;
                            _nu['players/' + child.key + '/roomSeat'] = null;
                            _nu['players/' + child.key + '/nightMuted'] = true;
                            _nu['players/' + child.key + '/audioMuted'] = true;
                            _nu['players/' + child.key + '/videoMuted'] = true;
                            if (player.seat) _nu['game/seats/' + player.seat] = null;
                            database.ref().update(_nu);
                        }
                    });
                    // Reset breakfast seat counter so next breakfast starts from seat 1
                    database.ref('game/breakfastSeatCounter').remove();
                });
            }
        } else {
            hideNightOverlay();
            
            // Only show seats when transitioning to a non-overlay phase.
            // breakfast is also an overlay phase — don't expose seats when entering it.
            const _isOverlayPhase = (phase === 'breakfast' || phase === 'night');
            if (currentUser.role === 'player' && !_isOverlayPhase) {
                console.log('Leaving night/breakfast phase - showing seats for player');
                document.querySelectorAll('.video-seat').forEach(seat => {
                    seat.style.removeProperty('display');
                    seat.style.removeProperty('visibility');
                });
                const tabContainer = document.querySelector('.tab-container');
                if (tabContainer) {
                    tabContainer.style.removeProperty('display');
                    tabContainer.style.removeProperty('visibility');
                }
            }
            // Host: clear nightMuted flag for all players when night fully ends
            if (currentUser.role === 'host' && !_isOverlayPhase) {
                database.ref('players').once('value', (snapshot) => {
                    snapshot.forEach((child) => {
                        const player = child.val();
                        if (player.nightMuted && !player.isProdMember) {
                            database.ref('players/' + child.key).update({
                                nightMuted: null
                            });
                        }
                    });
                });
            }
        }
    }

function showNightOverlay() {
    if (currentUser.role !== 'player') return;
    if (currentUser.room === 'turret') return;
    const overlay = document.getElementById('night-overlay') || createNightOverlay();
    const roomOverlay = document.getElementById('room-overlay');
    if (roomOverlay) roomOverlay.style.display = 'none';
    overlay.classList.add('visible');
    overlay.style.display = 'flex';
    overlay.style.position = 'fixed'; overlay.style.top = '0'; overlay.style.left = '0';
    overlay.style.width = '100%'; overlay.style.height = '100%';
    overlay.style.setProperty('z-index', '10000', 'important');
    // Removed async Firebase re-verification — it read stale 'turret' and re-hid the overlay
}

function hideNightOverlay() {
    const overlay = document.getElementById('night-overlay');
    if (overlay) {
        overlay.classList.remove('visible');
    }
}

function createNightOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'night-overlay';
    overlay.className = 'overlay-screen';
    overlay.innerHTML = '<div class="overlay-message">The Traitors Are Meeting In The Turret...</div>';
    document.body.appendChild(overlay);
    return overlay;
}

// ============================================
// TIMER MANAGEMENT
// ============================================

let timerInterval = null;

function updateTimerDisplay(timer) {
    const timerElement = document.getElementById('timer');
    const phaseElement = document.getElementById('phase-name');
    
    if (timerElement) {
        const mins = Math.floor(timer.remainingSeconds / 60);
        const secs = timer.remainingSeconds % 60;
        timerElement.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    
    if (phaseElement && timer.phase) {
        phaseElement.textContent = timer.phase;
    }
}

function playGongSound() {
    // Play audio cue when timer expires
    const audio = new Audio('gong.mp3');
    audio.play().catch(e => console.log('Could not play gong sound:', e));
}

// ============================================
// VIDEO SEAT GENERATION
// ============================================

function generateVideoSeats() {
    // Note: existing seats are REUSED (repositioned) where possible.
    // Only newly-added seats are created; only removed seats are deleted.
    // This preserves video feeds and name labels across seat count changes.

    // Hide ALL existing player seats before repositioning so they never
    // flash at the wrong position. They are revealed below after all
    // coordinates are calculated and applied — same technique as the host seat.
    document.querySelectorAll('.video-seat:not(#seat-A)').forEach(s => {
        s.style.visibility = 'hidden';
    });

    // ============================================
    // DEFINE THREE SECTIONS OF THE PAGE
    // ============================================
    
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    
    // On narrow mobile screens the right-side tab panel becomes a bottom bar,
    // freeing the full width for seats. Shrink the side section margins accordingly.
    const _isMobile = viewportWidth <= 600;
    // Landscape phone: wide but very short — treat like mobile for sizing purposes
    const _isLandscapeMobile = !_isMobile && viewportHeight <= 500 && viewportWidth <= 1024;
    const _isMobileLayout = _isMobile || _isLandscapeMobile;
    // Define section widths as percentages (21% of viewport)
    const sectionWidthPercent = _isMobileLayout ? 6 : 12; // Each side section is 12% of viewport
    const sectionWidthPx = (viewportWidth * sectionWidthPercent) / 100;
    
    console.log(`Section width: ${sectionWidthPx}px = ${sectionWidthPercent.toFixed(2)}%`);
    
    // LEFT SECTION: Host seat area (mirrored from side panel)
    const leftSectionWidth = (viewportWidth * sectionWidthPercent) / 100;
    const leftSectionRight = leftSectionWidth; // Right border of left section
    
    // RIGHT SECTION: Side panel area
    const rightSectionWidth = (viewportWidth * sectionWidthPercent) / 100;
    const rightSectionLeft = viewportWidth - rightSectionWidth; // Left border of right section
    
    // CENTER SECTION: Player seats and timer
    const centerSectionLeft = leftSectionRight;
    const centerSectionRight = rightSectionLeft;
    const centerSectionWidth = centerSectionRight - centerSectionLeft;
    const centerSectionCenterX = centerSectionLeft + (centerSectionWidth / 2);
    
    console.log(`Left section: 0px to ${leftSectionRight.toFixed(0)}px`);
    console.log(`Center section: ${centerSectionLeft.toFixed(0)}px to ${centerSectionRight.toFixed(0)}px (${centerSectionWidth.toFixed(0)}px wide)`);
    console.log(`Right section: ${rightSectionLeft.toFixed(0)}px to ${viewportWidth}px`);
    console.log(`Center of center section: ${centerSectionCenterX.toFixed(0)}px`);
    
    // Boundaries for player seats (center section only)
    const leftBorderX = centerSectionLeft;
    const rightBorderX = centerSectionRight;
    const topBorderY = 20;
    const bottomBorderY = viewportHeight - (_isMobileLayout ? 110 : 50); // extra room for mobile/landscape bottom bar
    
    // Calculate seating area dimensions (center section)
    const seatingAreaWidth = centerSectionWidth;
    const seatingAreaHeight = bottomBorderY - topBorderY;
    
    // Center point is center of CENTER SECTION
    const centerX = centerSectionCenterX;
    const centerY = viewportHeight / 2; // Vertical center of viewport
    
    // ============================================
    // DYNAMIC SEAT SIZING (responsive to screen size)
    // ============================================
    
    // Calculate optimal seat size based on available space
    // Need to fit: 8 seats horizontally in top/bottom rows with gaps
    const topRowSeats = 8;
    const horizontalGapPercentage = 0.015; // 1.5% gap between seats
    const totalHorizontalGaps = topRowSeats + 1; // Gaps on sides and between
    const totalGapWidth = seatingAreaWidth * horizontalGapPercentage * totalHorizontalGaps;
    const availableForSeats = seatingAreaWidth - totalGapWidth;
    const maxSeatFromWidth = availableForSeats / topRowSeats;
    
    // Need to fit: 3 rows vertically with gaps
    const verticalRows = 3;
    const verticalGapPercentage = 0.08; // 8% vertical gap
    const totalVerticalGaps = verticalRows + 1;
    const totalVerticalGapHeight = seatingAreaHeight * verticalGapPercentage * totalVerticalGaps;
    const availableForHeight = seatingAreaHeight - totalVerticalGapHeight;
    const maxSeatFromHeight = availableForHeight / verticalRows;
    
    // Player seat size: smaller of width/height constraint
    const calculatedPlayerSize = Math.min(maxSeatFromWidth, maxSeatFromHeight);
    
    // Apply min/max constraints
    const minPlayerSize = _isMobileLayout ? 48 : 80; // Smaller minimum on mobile/landscape
    const maxPlayerSize = 200; // Maximum 200px for large screens
    const finalPlayerSize = Math.min(Math.max(calculatedPlayerSize, minPlayerSize), maxPlayerSize);
    
    // Host seat: double the player size
    const finalHostSize = finalPlayerSize * 2;
    
    console.log(`Calculated sizes: player=${finalPlayerSize.toFixed(0)}px, host=${finalHostSize.toFixed(0)}px`);
    
    // ============================================
    // CALCULATE POSITIONS (8-9-8 layout)
    // ============================================
    
    const seats = [];
    
    // Calculate spacing
    const horizontalGap = seatingAreaWidth * horizontalGapPercentage;
    const verticalGap = seatingAreaHeight * verticalGapPercentage;
    
    // ============================================
    // CREATE 8x3 GRID OF PLAYER SEATS
    // ============================================
    
    // Get seat count from Firebase (default to 24)
    const totalSeats = window.currentMainSeatCount || 24;
    
    // Calculate optimal grid layout based on seat count
    // Always use 8 columns max, and calculate rows needed
    let rows, cols;
    cols = _isMobile ? 6 : 8; // 6 columns on mobile for larger tap targets

    if (totalSeats <= 8) {
        rows = 1;
    } else if (totalSeats <= 16) {
        rows = 2;
    } else if (totalSeats <= 24) {
        rows = 3;
    } else if (totalSeats <= 32) {
        rows = 4;
    } else {
        // For more than 32, add more rows as needed
        rows = Math.ceil(totalSeats / cols);
    }
    
    console.log(`Creating ${rows}x${cols} grid for ${totalSeats} seats (will generate exactly ${rows * cols} seats)`);
    
    
    // Calculate spacing to fit in CENTER SECTION with tight margins
    const sideMargin = 20; // Small margin from red lines
    const availableWidth = centerSectionWidth - (2 * sideMargin); // Margin on both sides
    const availableHeight = seatingAreaHeight;
    
    // Calculate spacing: seats fill the width from left red line to right red line
    const horizontalSpacing = (availableWidth - cols * finalPlayerSize) / (cols - 1); // Gaps BETWEEN seats only
    const verticalSpacing = (availableHeight - rows * finalPlayerSize) / (rows + 1);
    
    // Calculate total grid dimensions
    const totalGridWidth = cols * finalPlayerSize + (cols - 1) * horizontalSpacing;
    const totalGridHeight = rows * finalPlayerSize + (rows - 1) * verticalSpacing;
    
    // Grid starts at left red line (with small margin)
    // Add half seat size because transform: translate(-50%, -50%) centers the seat on this point
    const gridStartX = centerSectionCenterX - (totalGridWidth / 2) + (finalPlayerSize / 2);
    
    // DEBUG: Verify centering (should be 0)
    const gridMiddleX = centerSectionCenterX; // Grid IS centered at this point
    const offsetFromCenter = 0; // Should be 0 by design
    
    console.log(`Grid start: ${gridStartX.toFixed(0)}px`);
    console.log(`Grid middle: ${gridMiddleX.toFixed(0)}px`);
    console.log(`Center section center: ${centerSectionCenterX.toFixed(0)}px`);
    console.log(`Offset from center: ${offsetFromCenter.toFixed(0)}px (should be ~0)`);

    // Center the ENTIRE grid vertically on page
    const middleRowY = viewportHeight / 2;
    
    // Start position should center the entire grid
    const gridStartY = middleRowY - (totalGridHeight / 2) + (finalPlayerSize / 2);
    
    console.log(`Grid will be vertically centered: total height ${totalGridHeight.toFixed(0)}px, start Y: ${gridStartY.toFixed(0)}px`);
    console.log(`Creating ${rows}x${cols} grid with spacing: H=${horizontalSpacing.toFixed(0)}px, V=${verticalSpacing.toFixed(0)}px`);
    
            // Calculate seat distribution per row (symmetrical pattern)
            const seatsPerRow = [];
            const baseSeatsPerRow = Math.floor(totalSeats / rows);
            const extraSeats = totalSeats % rows;
            
            // Start with base seats for all rows
            for (let i = 0; i < rows; i++) {
                seatsPerRow.push(baseSeatsPerRow);
            }
            
            // Add extra seats in this order for 3 rows: top, bottom, middle
            // For 24 seats (0 extra): [8, 8, 8]
            // For 23 seats (2 extra): [8, 8, 7] -> top and bottom get extras
            // For 22 seats (1 extra): [8, 7, 7] -> only top gets extra
            // For 21 seats (0 extra): [7, 7, 7]
            
            if (rows === 3) {
                // Special handling for 3 rows: distribute extras to outer rows first
                if (extraSeats === 2) {
                    seatsPerRow[0]++; // Top
                    seatsPerRow[2]++; // Bottom
                    // Middle stays at base (this gives us 8-7-8 for 23 seats)
                } else if (extraSeats === 1) {
                    seatsPerRow[1]++; // Middle only
                    // Top and bottom stay at base (this gives us 7-8-7 for 22 seats)
                }
                // If extraSeats === 0, all rows stay at base (gives us 8-8-8 for 24 or 7-7-7 for 21)
            } else {
                // For other row counts, distribute from outside toward center
                for (let i = 0; i < extraSeats; i++) {
                    if (i % 2 === 0) {
                        seatsPerRow[Math.floor(i / 2)]++; // Top rows first
                    } else {
                        seatsPerRow[rows - 1 - Math.floor(i / 2)]++; // Bottom rows
                    }
                }
            }
    
            console.log(`Total seats: ${totalSeats}, Base per row: ${baseSeatsPerRow}, Extra seats: ${extraSeats}`);
            console.log(`Seat distribution per row: [${seatsPerRow.join(', ')}]`);
            
            let seatNumber = 1; // Players start at seat 1 (host is seat A)
            
            // Generate seats row by row with centering
            for (let row = 0; row < rows; row++) {
            const seatsInThisRow = seatsPerRow[row];
            const missingSeats = cols - seatsInThisRow;
            const rowOffset = missingSeats / 2; // Center the row
            
            for (let col = 0; col < seatsInThisRow; col++) {
                const x = gridStartX + ((col + rowOffset) * (finalPlayerSize + horizontalSpacing));
                const y = gridStartY + (row * (finalPlayerSize + verticalSpacing));
                
                seats.push({
                    number: seatNumber,
                    x: x,
                    y: y,
                    size: finalPlayerSize
                });
                
                seatNumber++;

            }
        }
    
    console.log(`Generated ${seats.length} player seats in ${rows}x${cols} grid`);
    
    // ============================================
    // CREATE SEAT ELEMENTS
    // ============================================
    
    // Track the highest seat number in this render
    const _newMaxSeat = seats.length > 0 ? seats[seats.length - 1].number : 0;
    // Remove seats that no longer exist (beyond the new count)
    for (let _s = _newMaxSeat + 1; _s <= 25; _s++) {
        const _old = document.getElementById('seat-' + _s);
        if (_old) _old.remove();
    }

    seats.forEach(seat => {
        // REUSE existing seat element if it exists — avoids destroying video/name
        let seatElement = document.getElementById(`seat-${seat.number}`);
        if (seatElement) {
            // Just reposition — no DOM rebuild, video and name preserved
            seatElement.style.left   = `${seat.x}px`;
            seatElement.style.top    = `${seat.y}px`;
            seatElement.style.width  = `${seat.size}px`;
            seatElement.style.height = `${seat.size}px`;
            // Reset onclick to normal seat-selection handler so stale voting
            // handlers from a previous round don't persist on reused elements.
            if (!seatElement.dataset.votingClickHandler) {
                const _rn = seat.number;
                seatElement.onclick = (e) => {
                    if (e.target.closest('.seat-label')) return;
                    handleSeatClick(_rn);
                };
            }
            return; // skip the rest of this iteration
        }
        // NEW seat — create from scratch
        const seatElement2 = document.createElement('div');
        seatElement2.className = 'video-seat empty';
        seatElement2.id = `seat-${seat.number}`;
        seatElement2.style.position = 'fixed';
        seatElement2.style.left = `${seat.x}px`;
        seatElement2.style.top = `${seat.y}px`;
        seatElement2.style.width = `${seat.size}px`;
        seatElement2.style.height = `${seat.size}px`;
        seatElement2.style.transform = 'translate(-50%, -50%)';
        
        // Name tag below seat
        const labelStyle = 'position: absolute; top: calc(100% + 5px); left: 50%; transform: translateX(-50%); white-space: nowrap;';
        
        seatElement2.innerHTML = `
            <div id="video-${seat.number}"></div>
            <div class="seat-label" id="seat-label-${seat.number}">
                <button class="av-btn mic-btn" id="mic-btn-${seat.number}" title="Toggle Mic (M)" onclick="event.stopPropagation(); window.toggleMic && window.toggleMic()">
                    <svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                </button>
                <button class="av-btn cam-btn" id="cam-btn-${seat.number}" title="Toggle Camera (V)" onclick="event.stopPropagation(); window.toggleCam && window.toggleCam()">
                    <svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
                </button>
                <span class="player-name" id="name-${seat.number}">Empty</span>
                <span class="player-pronouns" id="pronouns-${seat.number}"></span>
            </div>
            <div class="seat-av-controls" id="av-controls-${seat.number}" style="display:none"></div>
            <div class="av-status-icons" id="av-status-${seat.number}">
                <span class="av-icon mic-off-icon" id="mic-off-${seat.number}" style="display:none">
                    <svg viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                </span>
                <span class="av-icon cam-off-icon" id="cam-off-${seat.number}" style="display:none">
                    <svg viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
                </span>
            </div>
            ${currentUser.role === 'host' ? `
            <button class="seat-remove-btn" id="remove-${seat.number}" onclick="removeSeatVisually(${seat.number})" title="Remove this seat" style="display: none;">
                ✕
            </button>
            ` : ''}
            <div class="vote-indicator" id="vote-${seat.number}"></div>
            <div class="audio-ring" id="aring-${seat.number}"></div>
        `;
        
        seatElement2.addEventListener('click', (e) => {
            // Don't trigger if clicking controls, labels, or remove buttons
            if (
                e.target.closest('.seat-label') || 
                e.target.closest('.seat-remove-btn') ||
                e.target.closest('.vote-indicator')) {
                return;
            }
            
            // NEW: Check if in Circle of Truth selection mode
            if (window.circleOfTruthSelectionMode) {
                e.stopPropagation();
                window.removeSeatVisually(seat.number);
                return;
            }
            
            // HOST: show seat action menu (Assign Vote / Reveal Vote / Reveal Role)
            if (window.currentUser && window.currentUser.role === 'host') {
                _showHostSeatActionMenu(seat.number, e.clientX, e.clientY);
                return;
            }
            
            // Normal seat claiming
            handleSeatClick(seat.number);
        });
        // Hide before appending so the browser never paints this seat
        // at an incorrect position. It will be revealed at the end of
        // generateVideoSeats() once all positions are finalised.
        seatElement2.style.visibility = 'hidden';
        document.body.appendChild(seatElement2);
    });
    
    console.log(`Generated 24 player seats in 8x3 grid layout`);

    // Reveal all player seats now that every seat has its final position.
    // They were hidden at the top of this function to prevent a flash at
    // the wrong position. Only reveal if not in night/breakfast overlay.
    const _revealPhase = window._currentPhase || '';
    if (_revealPhase !== 'night' && _revealPhase !== 'breakfast') {
        document.querySelectorAll('.video-seat:not(#seat-A)').forEach(s => {
            if (!s.style.getPropertyValue('display').includes('none')) {
                s.style.visibility = '';
            }
        });
    }

    // After generating new seat DOM elements, re-apply night/breakfast hiding
    // if the current phase requires it. New elements have no inline style, so
    // the old display:none is lost every time seats are regenerated.
    if (currentUser && currentUser.role === 'player') {
        const _phaseAtGenerate = window._currentPhase || '';
        if (_phaseAtGenerate === 'night' || _phaseAtGenerate === 'breakfast') {
            // Exception: player was invited back to main room during breakfast — don't re-hide.
            if (!window._breakfastSeatVisible) {
                document.querySelectorAll('.video-seat').forEach(s => {
                    s.style.setProperty('display', 'none', 'important');
                    s.style.setProperty('visibility', 'hidden', 'important');
                });
                console.log('🌙 generateVideoSeats: re-hid seats (phase:', _phaseAtGenerate, ')');
            } else {
                console.log('🌙 generateVideoSeats: skipping re-hide — breakfast seat visible (invited back)');
            }
        }
    }

    // ============================================
    // GENERATE ROOM-SPECIFIC SEATS
    // ============================================
    window.generateRoomSeats = function(roomId, seatLimit) {
        console.log(`🏠 Generating ${seatLimit} seats for room: ${roomId}`);
        
        const container = document.getElementById('room-seats-container');
        if (!container) {
            console.error('Room seats container not found!');
            return;
        }
        
        // Clear existing room seats
        container.innerHTML = '';
        
        // Get layout configuration
        const layout = getLayoutForSeatCount(seatLimit);
        const { rows, cols, pattern } = layout;
        
        // Calculate positioning
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Seat size matching main roundtable calculation
        const seatSize = Math.min(200, viewportWidth * 0.156);
        window.currentRoomSeatSize = seatSize; // stored for hand indicator sizing
        const horizontalSpacing = seatSize * 0.3;
        const verticalSpacing = seatSize * 0.3;
        
        // Calculate total grid dimensions
        const totalWidth = (cols * seatSize) + ((cols - 1) * horizontalSpacing);
        const totalHeight = (rows * seatSize) + ((rows - 1) * verticalSpacing);
        
        // Center the grid
        const startX = (viewportWidth - totalWidth) / 2;
        const startY = (viewportHeight - totalHeight) / 2;
        
        let seatIndex = 0;
        
        // Generate seats row by row
        for (let row = 0; row < rows; row++) {
            const seatsInRow = pattern[row];
            const rowWidth = (seatsInRow * seatSize) + ((seatsInRow - 1) * horizontalSpacing);
            const rowStartX = (viewportWidth - rowWidth) / 2;
            
            for (let col = 0; col < seatsInRow; col++) {
                if (seatIndex >= seatLimit) break;
                
                seatIndex++;
                
                const x = rowStartX + (col * (seatSize + horizontalSpacing));
                const y = startY + (row * (seatSize + verticalSpacing));
                
                // Create seat element
                const seatElement = document.createElement('div');
                seatElement.id = `room-seat-${seatIndex}`;
                seatElement.className = 'video-seat room-seat';
                seatElement.style.cssText = `
                    position: absolute;
                    left: ${x}px;
                    top: ${y}px;
                    width: ${seatSize}px;
                    height: ${seatSize}px;
                    pointer-events: auto;
                    transition: all 0.3s ease-out;
                `;
                
                // Video container
                const videoDiv = document.createElement('div');
                videoDiv.id = `room-video-${seatIndex}`;
                videoDiv.className = 'video-container';
                videoDiv.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;border-radius:50%;overflow:hidden;';
                
                // Name tag with AV buttons as 'shoulders' inside it
                const nameTag = document.createElement('div');
                nameTag.className = 'seat-label';
                nameTag.id = `seat-label-room-${seatIndex}`;
                nameTag.innerHTML = `
                    <button class="av-btn mic-btn" id="room-mic-btn-${seatIndex}" title="Toggle Mic (M)" onclick="event.stopPropagation();window.toggleMic&&window.toggleMic()"><svg viewBox='0 0 24 24' fill='white' width='14' height='14'><path d='M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z'/></svg></button>
                    <button class="av-btn cam-btn" id="room-cam-btn-${seatIndex}" title="Toggle Camera (V)" onclick="event.stopPropagation();window.toggleCam&&window.toggleCam()"><svg viewBox='0 0 24 24' fill='white' width='14' height='14'><path d='M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z'/></svg></button>
                    <span id="room-name-${seatIndex}" class="player-name">Empty</span>
                    <span id="room-pronouns-${seatIndex}" class="player-pronouns"></span>
                `;

                // Empty legacy container (referenced by some code paths)
                const roomAvDiv = document.createElement('div');
                roomAvDiv.id = `room-av-controls-${seatIndex}`;
                roomAvDiv.style.display = 'none';

                // AV status icons (mic-off/cam-off indicators for other players' seats)
                const roomStatusDiv = document.createElement('div');
                roomStatusDiv.id = `room-av-status-${seatIndex}`;
                roomStatusDiv.className = 'av-status-icons';
                roomStatusDiv.innerHTML = `
                    <span class="av-icon mic-off-icon" id="room-mic-off-${seatIndex}" style="display:none"><svg viewBox='0 0 24 24' fill='white' width='12' height='12'><path d='M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z'/></svg></span>
                    <span class="av-icon cam-off-icon" id="room-cam-off-${seatIndex}" style="display:none"><svg viewBox='0 0 24 24' fill='white' width='12' height='12'><path d='M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z'/></svg></span>
                `;

                seatElement.appendChild(videoDiv);
                seatElement.appendChild(nameTag);
                seatElement.appendChild(roomAvDiv);
                seatElement.appendChild(roomStatusDiv);
                container.appendChild(seatElement);
            }
        }
        
        console.log(`✅ Generated ${seatIndex} room seats for ${roomId}`);
    }

    // Show room overlay with seats (GLOBAL for player.html access)
    window.showRoomOverlay = function(roomId, seatLimit) {
        const overlay = document.getElementById('room-overlay');
        if (overlay) {
            overlay.style.display = 'block';
            
            // Update room name display — write to top-left #breakout-room-label
            const roomNames = {
                'kitchen': 'Kitchen',
                'library': 'Library',
                'living': 'Living Room',
                'courtyard': 'Courtyard',
                'bathroom': 'Bathroom',
                'gym': 'Gym',
                'turret': 'The Turret'
            };
            const _brlEl  = document.getElementById('breakout-room-label');
            const _brnEl  = document.getElementById('breakout-room-name');
            if (_brnEl) _brnEl.textContent = roomNames[roomId] || roomId;
            if (_brlEl) _brlEl.style.display = 'block';

            // Start (or restart) real-time watcher for prod members in this room
            if (window._prodInRoomListenerGJ) {
                database.ref('players').off('value', window._prodInRoomListenerGJ);
            }
            const _watchRoomGJ = roomId;
            window._prodInRoomListenerGJ = database.ref('players').on('value', (_pSnGJ) => {
                const _pElGJ = document.getElementById('prod-in-room-display');
                if (!_pElGJ) return;
                const _names = [];
                _pSnGJ.forEach((_ch) => {
                    const _pl = _ch.val();
                    // Include prod members AND the main host (isHost) — both are production
                    if (_pl && (_pl.isProdMember || _pl.isHost) && _pl.room === _watchRoomGJ && _pl.name) {
                        _names.push(_pl.name);
                    }
                });
                if (_names.length === 1) {
                    _pElGJ.textContent = _names[0] + ' is here.';
                } else if (_names.length === 2) {
                    _pElGJ.textContent = _names[0] + ' and ' + _names[1] + ' are here.';
                } else if (_names.length > 2) {
                    const _ln = _names[_names.length - 1];
                    const _rs = _names.slice(0, -1).join(', ');
                    _pElGJ.textContent = _rs + ', and ' + _ln + ' are here.';
                } else {
                    _pElGJ.textContent = '';
                }
            });
            
            generateRoomSeats(roomId, seatLimit);
            // Re-apply mute/cam-off icons + hand indicators for newly created room seats
            setTimeout(() => {
                if (typeof window._refreshAVIcons === 'function') window._refreshAVIcons();
                // Re-trigger players listener to re-apply any raised hands
                database.ref('players').once('value', (pSnap) => {
                    if (!pSnap.val()) return;
                    const _phase = (window._currentPhase || '').toLowerCase();
                    const _ok = !['night','breakfast'].some(b => _phase.includes(b));
                    pSnap.forEach((child) => {
                        const pl = child.val();
                        if (!pl || !pl.handRaised || !_ok) return;
                        if (pl.room && pl.room !== 'main' && pl.roomSeat) {
                            const rs = document.getElementById('room-seat-' + pl.roomSeat);
                            if (rs && !rs.querySelector('.hand-raised-indicator')) {
                                const hand = document.createElement('div');
                                hand.className = 'hand-raised-indicator';
                                hand.textContent = '✋';
                                hand.style.cssText = _handIndicatorStyle(rs);
                                rs.appendChild(hand);
                            }
                        }
                    });
                });
            }, 100);

            // ── Populate room seat names from Firebase ───────────────────
            if (window._roomNamesListener) {
                database.ref('players').off('value', window._roomNamesListener);
            }
            window._roomNamesListener = database.ref('players').on('value', (pSnap) => {
                // Reset all seat labels AND AV icons together so departed players
                // leave no ghost names or icons behind
                for (let s = 1; s <= seatLimit; s++) {
                    const nameEl = document.getElementById('room-name-' + s);
                    const pronEl = document.getElementById('room-pronouns-' + s);
                    if (nameEl) nameEl.textContent = 'Empty';
                    if (pronEl) pronEl.textContent = '';
                    const micOff = document.getElementById('room-mic-off-' + s);
                    const camOff = document.getElementById('room-cam-off-' + s);
                    if (micOff) micOff.style.display = 'none';
                    if (camOff) camOff.style.display = 'none';
                }
                pSnap.forEach((child) => {
                    const p = child.val();
                    if (!p || p.room !== roomId || !p.roomSeat) return;
                    const nameEl = document.getElementById('room-name-' + p.roomSeat);
                    const pronEl = document.getElementById('room-pronouns-' + p.roomSeat);
                    if (nameEl) nameEl.textContent = p.name || 'Player';
                    if (pronEl) pronEl.textContent = p.pronouns || '';
                    // Re-apply AV icons for players currently in this room
                    const micOff = document.getElementById('room-mic-off-' + p.roomSeat);
                    const camOff = document.getElementById('room-cam-off-' + p.roomSeat);
                    if (micOff) micOff.style.display = p.audioMuted ? 'flex' : 'none';
                    if (camOff) camOff.style.display = p.videoMuted ? 'flex' : 'none';
                });
            });

            // ── Re-attach already-subscribed video tracks ─────────────────
            // Run at 500ms and again at 2s to handle LiveKit connecting after overlay opens
            const _reattachRoomVideo = () => {
                const lkRoom = window._lkRoom;
                if (!lkRoom) return;
                lkRoom.remoteParticipants.forEach(async (participant) => {
                    const seat = await _lkIdentityToSeat(participant.identity, false);
                    if (!seat) return;
                    participant.trackPublications.forEach((pub) => {
                        if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                            _lkAttachVideo(pub.track, seat, false, 0);
                            console.log('📹 Re-attached room video for', participant.identity, '→ room-video-' + seat);
                        }
                    });
                });
            };
            setTimeout(_reattachRoomVideo, 500);
            setTimeout(_reattachRoomVideo, 2000);
            setTimeout(_reattachRoomVideo, 4000);
        }
    }

    // Hide room overlay (return to main roundtable) (GLOBAL for player.html access)
    window.hideRoomOverlay = function() {
        const overlay = document.getElementById('room-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
        // Hide breakout room label and clean up prod watcher
        const _brlH = document.getElementById('breakout-room-label');
        if (_brlH) _brlH.style.display = 'none';
        if (window._prodInRoomListenerGJ) {
            database.ref('players').off('value', window._prodInRoomListenerGJ);
            window._prodInRoomListenerGJ = null;
        }
        // Re-apply mute/cam-off icons on main room seats after returning from breakout
        setTimeout(() => {
            if (typeof window._refreshAVIcons === 'function') window._refreshAVIcons();
        }, 100);
        // Clean up room names listener
        if (window._roomNamesListener) {
            database.ref('players').off('value', window._roomNamesListener);
            window._roomNamesListener = null;
        }
    }

    // Mark that seats have been generated
    window.seatsGenerated = true;

    // Store values for host positioning
    window.seatingCenterX = centerX;
    window.seatingCenterY = centerY;
    window.currentPlayerSize = finalPlayerSize;
    window.currentHostSize = finalHostSize;

    // ============================================
    // POSITION HOST SEAT IN LEFT SECTION
    // ============================================
    
    const hostSeat = document.getElementById('seat-A');
    if (hostSeat) {
        let hostX, hostY, actualHostSize;
        if (_isMobileLayout) {
            // On mobile the left section is only ~23px wide — too narrow to use.
            // Instead, pin the host seat to the top-left with a clear margin
            // so it's fully visible and not cut off by the screen edge.
            actualHostSize = Math.min(finalHostSize, 70); // smaller on mobile — less overlap with seat 1
            hostX = (actualHostSize / 2) + 8; // 8px from left edge
            hostY = (actualHostSize / 2) + 8; // 8px from top edge
        } else {
            // Desktop: center host in left section
            hostX = leftSectionWidth / 2;
            hostY = leftSectionWidth / 2;
            const maxHostSize = leftSectionWidth - 40; // 20px margin each side
            actualHostSize = Math.min(finalHostSize, maxHostSize);
        }
        
        hostSeat.style.position = 'fixed';
        hostSeat.style.left = `${hostX}px`;
        hostSeat.style.top = `${hostY}px`;
        hostSeat.style.width = `${actualHostSize}px`;
        hostSeat.style.height = `${actualHostSize}px`;
        hostSeat.style.transform = 'translate(-50%, -50%)';
        hostSeat.style.visibility = 'visible'; // reveal now that position is correct
        
        console.log(`Host positioned in left section: (${hostX.toFixed(0)}, ${hostY}) with size ${actualHostSize.toFixed(0)}px`);

        // Make seat-A clickable for prod members to request switch with main host
        if (hostSeat && !hostSeat._switchHandlerAdded) {
            hostSeat._switchHandlerAdded = true;
            hostSeat.addEventListener('click', (e) => {
                if (!window.currentUser || !window.currentUser.seat) return;
                const mySeat = window.currentUser.seat;
                if (mySeat === 'A') return; // already main host
                if (!['B','C','D'].includes(String(mySeat))) return;
                _showSeatSwitchMenu('A', e.clientX, e.clientY);
            });
        }

        // Position production member seats below the main host
        _positionProdSeats(hostX, hostY, actualHostSize, finalPlayerSize, leftSectionWidth);

        // After seat elements exist, do one direct read to set names/pronouns.
        // This covers the race where the players listener or _positionProdSeats
        // inner listener fired before seat elements existed and returned early.
        setTimeout(() => {
            database.ref('players').once('value', (_nameSnap) => {
                _nameSnap.forEach((_nc) => {
                    const _np = _nc.val();
                    if (!_np || !_np.seat) return;
                    const _seat = String(_np.seat);
                    const _nameEl = document.getElementById('name-' + _seat);
                    const _pronEl = document.getElementById('pronouns-' + _seat);
                    if (!_nameEl) return;
                    // Always update name and pronouns from Firebase (authoritative)
                    if (_np.name) {
                        _nameEl.textContent = _np.name;
                        _nameEl.style.fontFamily = 'Arial, sans-serif';
                        _nameEl.style.fontSize = _nameFontSize();
                        _nameEl.style.color = '#fff';
                    }
                    if (_pronEl) {
                        _pronEl.textContent = _np.pronouns || '';
                    }
                });
            });
        }, 500); // 500ms gives Firebase listeners time to fire first

        console.log(`Host positioned at top-left: (${hostX}, ${hostY}) with size ${finalHostSize}px`);
    }
    
    // Re-attach rename handlers if function exists
    if (typeof attachRenameHandlers === 'function') {
        setTimeout(() => attachRenameHandlers(), 100);
    }

    // Re-show remove buttons if seat remove mode is active
    if (typeof window.seatRemoveModeActive !== 'undefined' && window.seatRemoveModeActive) {
        setTimeout(() => {
            document.querySelectorAll('.seat-remove-btn').forEach(removeBtn => {
                removeBtn.style.display = 'flex';
            });
        }, 100);
    }
}

    // ============================================
    // REGENERATE SEATS WITH NEW COUNT
    // ============================================
    function regenerateSeatsWithState(newCount) {
        console.log('Regenerating seats with new count:', newCount);
        
        // Store current player positions
        const playerPositions = {};
        Object.values(gameState.players || {}).forEach(player => {
            if (player.seat) {
                playerPositions[player.seat] = player;
            }
        });

        // Regenerate seats
        generateSeats(newCount);
        
        // Force update player display
        setTimeout(() => {
            updatePlayerDisplay();
        }, 100);
    }

    function regenerateSeatsWithNewCount(newCount) {
        // Don't regenerate if player is in night/breakfast
        if (currentUser.role === 'player') {
            const phase = sessionStorage.getItem('currentPhase'); // Use cached phase
            if (phase === 'night' || phase === 'breakfast') {
                console.log('Skipping seat regeneration during', phase);
                return; // Exit the entire function
            }
        }

        console.log(`Regenerating seats with new count: ${newCount}`);
        
        // Step 1: Check if any players are in seats that will be removed
        const seatsToRemove = [];
        const currentTotalSeats = document.querySelectorAll('.video-seat').length; // host is seat-A, not counted here
        
        // Count only numeric player seats (not seat-A or prod letter seats)
        const playerSeatCount = Array.from(document.querySelectorAll('.video-seat'))
            .filter(el => /^seat-\d+$/.test(el.id)).length;
        if (newCount < playerSeatCount) {
            // We're removing player seats (numbered 1..current)
            for (let i = newCount + 1; i <= playerSeatCount; i++) {
                seatsToRemove.push(i);
            }
            
            // Check if any players are in these seats
            const playersInRemovedSeats = [];
            for (const playerId in gameState.players) {
                const player = gameState.players[playerId];
                if (player.seat && seatsToRemove.includes(player.seat)) {
                    playersInRemovedSeats.push(player.name);
                    // Remove player from their seat
                    database.ref(`players/${playerId}/seat`).remove();
                }
            }
            
            if (playersInRemovedSeats.length > 0) {
                console.log(`Removed players from deleted seats: ${playersInRemovedSeats.join(', ')}`);
            }
        }
        
        // Step 2: Mark regeneration in progress (no seat destruction — generateVideoSeats
        // now reuses existing seats, only adding/removing the ones that changed)
        window._regeneratingSeats = true;
        
        // Step 3: Clean up any stale host/prod entries from numeric player seats
        database.ref('game/seats').once('value', (seatsSnap) => {
            const seatEntries = seatsSnap.val() || {};
            const cleanups = {};
            for (const seatNum in seatEntries) {
                const occupantId = seatEntries[seatNum];
                // Numeric seat keys only; if occupant is host or starts with 'host-', remove
                if (/^\d+$/.test(seatNum) && occupantId &&
                    (occupantId === 'host' || String(occupantId).startsWith('host-'))) {
                    cleanups['game/seats/' + seatNum] = null;
                    // Also restore the host/prod seat field back to its correct letter
                    if (occupantId === 'host') {
                        cleanups['players/host/seat'] = 'A';
                    } else {
                        // prod-B → seat B, prod-C → seat C, etc.
                        const _parts = String(occupantId).split('-');
                        const _letter = _parts[_parts.length - 1];
                        if (_letter && /^[B-J]$/.test(_letter)) {
                            cleanups['players/' + occupantId + '/seat'] = _letter;
                        }
                    }
                    console.log('🧹 Restoring host/prod from numeric seat', seatNum, '→ correct letter for', occupantId);
                }
            }
            if (Object.keys(cleanups).length) database.ref().update(cleanups);
        });

        // Step 4: Regenerate with new count
        generateVideoSeats();

        // (Step 5 removed — seats are now reused in place, no name flash possible)
    }

    // ============================================
    // FUNCTIONS
    // ============================================
    
    // Function to edit pronouns
    function editNameAndPronouns(seatNumber) {
        // Only allow editing own info
        if (currentUser.seat !== seatNumber) {
            return;
        }
        
        // Show modal to edit both name and pronouns
        document.getElementById('name-pronouns-modal').classList.add('visible');
        
        // Pre-fill with current values
        document.getElementById('modal-name-input').value = currentUser.name || '';
        
        // Get current pronouns from Firebase
        const userPath = currentUser.role === 'host' ? 'players/host' : 'players/' + currentUser.id;
        database.ref(userPath + '/pronouns').once('value', (snapshot) => {
            document.getElementById('modal-pronouns-input').value = snapshot.val() || '';
        });
        
        document.getElementById('name-pronouns-error').style.display = 'none';
        
        // Mark as editing mode (not claiming new seat)
        window.editingNamePronouns = true;
    }

    function handleSeatClick(seatNumber) {
        // Only players can interact with seats
        if (currentUser.role !== 'player') return;
        // Block main room seat clicks when player is in a breakout room
        if (currentUser.room && currentUser.room !== 'main' && currentUser.room !== 'waiting') {
            console.log('🚫 Blocked main room seat click — player is in breakout room:', currentUser.room);
            return;
        }
        
        // Check game state first
        Promise.all([
            database.ref('game/firstVote/active').once('value'),
            database.ref('game/seats/' + seatNumber).once('value')
        ]).then(([votingSnapshot, seatSnapshot]) => {
            const votingActive = votingSnapshot.val();
            const seatTaken = seatSnapshot.val();
            
            // Check if seat is taken
            if (seatTaken) {
                // Always silent - no alert during any phase
                console.log('Seat already taken by:', seatTaken);
                return;
            }
            
            // Allow seat selection during ANY phase (for rejoining players)
            console.log('Allowing seat selection');
            
            // If player already has name, claim seat directly
            if (currentUser.name && currentUser.name !== 'New Player') {
                claimSeat(seatNumber, currentUser.name, currentUser.pronouns || '');
            } else {
                // Otherwise, prompt for player name
                showPlayerNameModal(seatNumber);
            }
        });
    }

    function showPlayerNameModal(seatNumber) {
        // Store the seat number globally so we can access it from the modal
        window.pendingSeatNumber = seatNumber;
        
        // Show the modal
        document.getElementById('name-pronouns-modal').classList.add('visible');
        
        // Pre-fill with current values if they exist
        document.getElementById('modal-name-input').value = currentUser.name || '';
        document.getElementById('modal-pronouns-input').value = currentUser.pronouns || '';
        document.getElementById('name-pronouns-error').style.display = 'none';
        
        // Focus on name input
        setTimeout(() => {
            document.getElementById('modal-name-input').focus();
        }, 100);
    }

    function submitNameAndPronouns() {
        const name = document.getElementById('modal-name-input').value.trim();
        const pronouns = document.getElementById('modal-pronouns-input').value.trim();
        const errorElement = document.getElementById('name-pronouns-error');
        
        // Validate name
        if (!name || name.length === 0) {
            errorElement.textContent = 'Please enter a name';
            errorElement.style.display = 'block';
            return;
        }
        
        const trimmedName = name.substring(0, 12);
        const trimmedPronouns = pronouns.substring(0, 20);
        
        // If editing existing name/pronouns
        if (window.editingNamePronouns) {
            const userPath = currentUser.role === 'host' ? 'players/host' : 'players/' + currentUser.id;
            database.ref(userPath).update({
                name: trimmedName,
                pronouns: trimmedPronouns
            });
            
            currentUser.name = trimmedName;
            sessionStorage.setItem('playerName', trimmedName);
            
            window.editingNamePronouns = false;
            closeNamePronounsModal();
            console.log('Updated name to:', trimmedName, 'and pronouns to:', trimmedPronouns);
            return;
        }
        
        // If this is initial name entry for player (no pending seat, in waiting room)
        if (!window.pendingSeatNumber && currentUser.role === 'player') {
            console.log('=== NAME SUBMISSION DEBUG ===');
            console.log('Player ID:', currentUser.id);
            console.log('Current name:', currentUser.name);
            console.log('New name to set:', trimmedName);
            console.log('Pronouns:', trimmedPronouns);
            console.log('About to update Firebase path: players/' + currentUser.id);
            
            // Update player info in Firebase - use UPDATE not SET to preserve other fields
            database.ref('players/' + currentUser.id).update({
                name: trimmedName,
                pronouns: trimmedPronouns,
                lastActive: Date.now()
            }).then(() => {
                console.log('✅ Firebase update successful!');
                console.log('Verifying update by reading back from Firebase...');
                
                // Verify the update actually happened
                database.ref('players/' + currentUser.id).once('value', (snapshot) => {
                    const updatedPlayer = snapshot.val();
                    console.log('Player data in Firebase after update:', updatedPlayer);
                    if (updatedPlayer.name === trimmedName) {
                        console.log('✅ NAME UPDATE VERIFIED IN FIREBASE!');
                    } else {
                        console.error('❌ NAME DID NOT UPDATE! Still shows:', updatedPlayer.name);
                    }
                });
                
                currentUser.name = trimmedName;
                currentUser.pronouns = trimmedPronouns;
                
                window.awaitingNameEntry = false;
                closeNamePronounsModal();
            }).catch(error => {
                console.error('Error updating player name:', error);
            });
            return;
        }
        
        // If claiming new seat
        if (window.pendingSeatNumber) {
            console.log('Claiming seat:', window.pendingSeatNumber);
            closeNamePronounsModal();
            claimSeat(window.pendingSeatNumber, trimmedName, trimmedPronouns);
        }
    }

        function closeNamePronounsModal() {
            document.getElementById('name-pronouns-modal').classList.remove('visible');
            window.pendingSeatNumber = null;
            window.editingNamePronouns = false;
        }

    function claimSeat(seatNumber, playerName, pronouns) {
        console.log('Attempting to claim seat:', seatNumber, 'for player:', playerName);
        
        // STEP 0: Clear any lingering video from previous seat (handles breakout return)
        // Scan all video-N containers and remove any owned by this player's identity
        const _myName = playerName;
        for (let _s = 1; _s <= 24; _s++) {
            if (_s === seatNumber) continue; // keep target seat
            const _vd = document.getElementById('video-' + _s);
            if (_vd && _vd.dataset.lkIdentity === _myName) {
                _vd.querySelectorAll('.lk-video').forEach(v => { v.srcObject = null; v.remove(); });
                delete _vd.dataset.lkIdentity;
                console.log('📹 Pre-claim: cleared lingering video from seat', _s);
            }
        }

        // STEP 1: Clear old seat and WAIT for it
        const oldSeat = currentUser.seat;
        
        const clearOldSeatPromise = oldSeat && oldSeat !== seatNumber
            ? database.ref('game/seats/' + oldSeat).remove().then(() => {
                console.log('✅ Cleared old seat:', oldSeat);
            })
            : Promise.resolve();
        
        clearOldSeatPromise.then(() => {
            // STEP 2: Check if target seat is available
            return database.ref('game/seats/' + seatNumber).once('value');
        }).then((snapshot) => {
            if (snapshot.val() && snapshot.val() !== currentUser.id) {
                console.log('❌ Seat', seatNumber, 'taken by:', snapshot.val());
                console.log('Current user:', currentUser.id);
                alert('This seat is already taken. Please choose another.');
                return Promise.reject('Seat taken');
            }
            
            // STEP 3: Claim the seat FIRST
            return database.ref('game/seats/' + seatNumber).set(currentUser.id);
        }).then(() => {
            console.log('✅ Claimed seat:', seatNumber);
            
            // STEP 4: Update player data
            return database.ref('players/' + currentUser.id).update({
                name: playerName,
                pronouns: pronouns || '',
                seat: seatNumber,
                room: 'main',
                lastActive: Date.now()
            });
        }).then(() => {
            // STEP 5: Update local state
            currentUser.name = playerName;
            currentUser.seat = seatNumber;
            currentUser.room = 'main';

            // IMMEDIATELY update display (don't wait for Firebase)
            const seatElement = document.getElementById(`seat-${seatNumber}`);
            if (seatElement) {
                seatElement.classList.remove('empty');
                seatElement.classList.add('active');
            }

            // Update global window reference
            window.currentUser = currentUser;

            sessionStorage.setItem('playerName', playerName);
            sessionStorage.setItem('playerSeat', seatNumber);
            
            // Show raise hand button now that seat is set
            // (game/seats listener may have fired before currentUser.seat was set)
            if (currentUser.role === 'player' && typeof window._showRaiseHandBtn === 'function') {
                window._showRaiseHandBtn();
            }
            
            console.log('✅ Successfully claimed seat:', seatNumber, 'as', playerName);
            
            // Update seat label immediately
            const nameLabel = document.getElementById(`name-${seatNumber}`);
            const pronounsLabel = document.getElementById(`pronouns-${seatNumber}`);
            
            if (nameLabel && pronounsLabel) {
                nameLabel.textContent = playerName;
                pronounsLabel.textContent = pronouns || '';
                console.log('✅ Updated seat label to show:', playerName);
            }

            // Enable name editing for players
            if (currentUser.role === 'player' && typeof enableNameEdit === 'function') {
                enableNameEdit();
            }

            // Setup and show player's own media controls
            if (currentUser.role === 'player') {
                if (typeof setupPlayerControls === 'function') {
                    setupPlayerControls(seatNumber);
                }
                if (typeof showPlayerControls === 'function') {
                    showPlayerControls();
                }
                // Show AV controls on this player's seat
                if (typeof window.setupAVControls === 'function') {
                    window.setupAVControls(seatNumber);
                }
                // Join LiveKit now if not yet connected — but ONLY if not in an overlay phase.
                // During night/breakfast, players must stay disconnected.
                const _claimPhase = window._currentPhase ||
                    sessionStorage.getItem('currentPhase') || '';
                const _claimOverlay = _claimPhase === 'night' || _claimPhase === 'breakfast';
                const _lkR = window._lkRoom;
                if (!_claimOverlay && (!_lkR || !_lkR.localParticipant)) {
                    const _joinRoom = window.currentUser && window.currentUser.room || 'main';
                    if (typeof window.joinLiveKitRoom === 'function') {
                        console.log('🔊 Joining LiveKit now that seat is claimed');
                        window.joinLiveKitRoom(_joinRoom);
                    }
                } else {
                    // Already connected — just unmute, respecting Firebase flags
                    const _pId = window.currentUser && window.currentUser.id;
                    database.ref('players/' + _pId).once('value', (pSnap) => {
                        const pData = pSnap.val() || {};
                        const _mp = _lkR.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                        const _cp = _lkR.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                        if (_mp) { pData.audioMuted ? _mp.mute() : _mp.unmute(); }
                        if (_cp) { pData.videoMuted ? _cp.mute() : _cp.unmute(); }
                        console.log('🔊 Tracks unblocked on seat claim | audioMuted:', !!pData.audioMuted, '| videoMuted:', !!pData.videoMuted);
                    });
                }
            }

            // Clear video from old seat and re-attach to new seat via LiveKit
            if (oldSeat && oldSeat !== seatNumber) {
                // Remove lingering video from old seat
                const oldVideoDiv = document.getElementById(`video-${oldSeat}`);
                if (oldVideoDiv) {
                    oldVideoDiv.querySelectorAll('.lk-video').forEach(v => { v.srcObject = null; v.remove(); });
                    delete oldVideoDiv.dataset.lkIdentity; // allow next player to claim
                    console.log('📹 Cleared video from old seat', oldSeat);
                }
                // LiveKit watcher will re-attach to new seat automatically
                // Force re-attach of own video to new seat
                const room = window._lkRoom;
                if (room && room.localParticipant) {
                    room.localParticipant.trackPublications.forEach((pub) => {
                        if (pub.kind === 'video' && pub.track) {
                            setTimeout(() => _lkAttachVideo(pub.track, seatNumber, true, 0, true), 200);
                        }
                    });
                }
            }

            // LiveKit handles video/audio automatically via the room watcher
        }).catch((error) => {
            if (error !== 'Seat taken') {
                console.error('Error claiming seat:', error);
            }
        });
    }
    // Expose claimSeat on window so preset auto-sit (player.html) can call it
    window.claimSeat = claimSeat;

// ============================================
// PLAYER DISPLAY UPDATES
// ============================================

    function updatePlayerDisplay() {
        // During night/breakfast, seats must stay hidden regardless of player updates.
        // Firebase writes (seat cleared, room changed) re-fire this function and
        // can re-show seats via CSS class changes. Re-apply the hide every time.
        const _updPhase = window._currentPhase || '';
        if (currentUser.role === 'player' && (_updPhase === 'night' || _updPhase === 'breakfast')) {
            // Exception: player was invited back to main room during breakfast
            if (!window._breakfastSeatVisible) {
                document.querySelectorAll('.video-seat').forEach(s => {
                    s.style.setProperty('display', 'none', 'important');
                    s.style.setProperty('visibility', 'hidden', 'important');
                });
                return; // No point updating display when overlay is active
            }
        }
        // Update main host seat (seat-A)
        const _hostPlayer = Object.values(gameState.players || {}).find(
            p => p.seat === 'A' || (p.isHost && !p.isProdMember)
        );
        if (_hostPlayer) {
            const _nameA = document.getElementById('name-A');
            const _pronA = document.getElementById('pronouns-A');
            // Show room label on host seat when host is in a breakout room,
            // same as player seats do via updateSeatDisplay.
            const _currentPhase = window._currentPhase || (gameState && gameState.phase);
            const _overlayActive = (_currentPhase === 'night' || _currentPhase === 'breakfast');
            // When a display swap is active, seat A shows the OTHER player (from seatB).
            // The overlay must track THAT player's room, not _hostPlayer's room.
            const _swH = window._activeDisplaySwap;
            const _seatASwapInvolved = _swH && (String(_swH.seatA) === 'A' || String(_swH.seatB) === 'A');
            let _seatADisplayPlayer = _hostPlayer; // who is SHOWN in seat A
            if (_seatASwapInvolved) {
                // Find the player who is DISPLAYED in seat A (the one from the other seat)
                const _otherSeat = String(_swH.seatA) === 'A' ? _swH.seatB : _swH.seatA;
                const _otherName = String(_swH.seatA) === 'A' ? _swH.nameB : _swH.nameA;
                const _otherPlayer = Object.values(gameState.players || {}).find(
                    p => p.name === _otherName || String(p.seat) === String(_otherSeat)
                );
                if (_otherPlayer) _seatADisplayPlayer = _otherPlayer;
            }
            const _hostInBreakout = !_overlayActive &&
                _seatADisplayPlayer.room && _seatADisplayPlayer.room !== 'main' && _seatADisplayPlayer.room !== 'waiting';
            const _hostRoomNames = {
                'kitchen': 'Kitchen', 'library': 'Library', 'living': 'Living Room',
                'courtyard': 'Courtyard', 'bathroom': 'Bathroom', 'gym': 'Gym', 'turret': 'Turret'
            };
            if (_nameA) {
                let _hostDisplayName = _hostPlayer.name || 'Host';
                if (_seatASwapInvolved) {
                    _hostDisplayName = String(_swH.seatA) === 'A' ? _swH.nameB : _swH.nameA;
                }
                _nameA.textContent = _hostDisplayName;
            }
            if (_pronA) {
                _pronA.textContent = _seatADisplayPlayer.pronouns || _hostPlayer.pronouns || '';
            }
            // Show/clear breakout overlay on video-A
            const _videoA = document.getElementById('video-A');
            if (_videoA) {
                let _overlayA = _videoA.querySelector('.name-overlay');
                if (_hostInBreakout) {
                    if (!_overlayA) {
                        _overlayA = document.createElement('div');
                        _overlayA.className = 'name-overlay';
                        _overlayA.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;background:rgba(0,0,0,0.8);border-radius:50%;color:white;text-align:center;z-index:5;';
                        _videoA.appendChild(_overlayA);
                    }
                    const _dispName = _seatASwapInvolved
                        ? (String(_swH.seatA) === 'A' ? _swH.nameB : _swH.nameA)
                        : (_hostPlayer.name || 'Host');
                    _overlayA.innerHTML = `<div style="font-size:1.1rem;font-weight:bold;">${_dispName}</div><div style="font-size:0.85rem;margin-top:4px;color:#bbb;">${_hostRoomNames[_seatADisplayPlayer.room] || _seatADisplayPlayer.room}</div>`;
                } else {
                    if (_overlayA) _overlayA.remove();
                }
            }
        }

        // Also update prod member seats (letter seats B-J)
        const _prodRoomNames = {
            'kitchen': 'Kitchen', 'library': 'Library', 'living': 'Living Room',
            'courtyard': 'Courtyard', 'bathroom': 'Bathroom', 'gym': 'Gym', 'turret': 'Turret'
        };
        const _prodPhase = window._currentPhase || (gameState && gameState.phase) || '';
        const _prodOverlayActive = (_prodPhase === 'night' || _prodPhase === 'breakfast');
        ['B','C','D'].forEach(letter => {
            const nameEl = document.getElementById('name-' + letter);
            if (!nameEl) return;
            // Find prod member in this seat (isProdMember=true; main host has isProdMember=false)
            const prodPlayer = Object.values(gameState.players || {}).find(
                p => p.seat === letter && p.isProdMember
            );
            if (prodPlayer) {
                // Respect display swap
                const _swP = window._activeDisplaySwap;
                let _pName = prodPlayer.name || letter;
                if (_swP) {
                    if (String(letter) === String(_swP.seatA)) _pName = _swP.nameB;
                    else if (String(letter) === String(_swP.seatB)) _pName = _swP.nameA;
                }
                nameEl.textContent = _pName;
                const pronEl = document.getElementById('pronouns-' + letter);
                // Respect display swap for pronouns too
                let _pPron = prodPlayer.pronouns || '';
                if (_swP) {
                    if (String(letter) === String(_swP.seatA)) _pPron = _swP.pronounsB || '';
                    else if (String(letter) === String(_swP.seatB)) _pPron = _swP.pronounsA || '';
                }
                if (pronEl) pronEl.textContent = _pPron;
                // Show black overlay when prod seat's DISPLAYED player is in breakout
                const _videoDiv = document.getElementById('video-' + letter);
                if (_videoDiv) {
                    // Find who is ACTUALLY displayed in this seat (may differ from prodPlayer after swap)
                    const _swOv = window._activeDisplaySwap;
                    let _displayedPlayer = prodPlayer;
                    if (_swOv) {
                        let _displayedName = null;
                        if (String(letter) === String(_swOv.seatA)) _displayedName = _swOv.nameB;
                        else if (String(letter) === String(_swOv.seatB)) _displayedName = _swOv.nameA;
                        if (_displayedName) {
                            const _dp = Object.values(gameState.players || {}).find(p => p.name === _displayedName);
                            if (_dp) _displayedPlayer = _dp;
                        }
                    }
                    const _inBreakout = !_prodOverlayActive &&
                        _displayedPlayer.room && _displayedPlayer.room !== 'main' && _displayedPlayer.room !== 'waiting';
                    let _overlay = _videoDiv.querySelector('.name-overlay');
                    if (_inBreakout) {
                        if (!_overlay) {
                            _overlay = document.createElement('div');
                            _overlay.className = 'name-overlay';
                            _overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;background:rgba(0,0,0,0.8);border-radius:50%;color:white;z-index:10;pointer-events:none;';
                            _videoDiv.appendChild(_overlay);
                        }
                        const _rName = _prodRoomNames[_displayedPlayer.room] || _displayedPlayer.room;
                        const _ovName = _displayedPlayer.name || letter;
                        _overlay.innerHTML = `<div style="font-size:1.2rem;font-weight:bold;">${_ovName}</div><div style="font-size:0.9rem;margin-top:5px;color:#bbb;">${_rName}</div>`;
                    } else {
                        if (_overlay) _overlay.remove();
                    }
                }
            }
        });
        for (let i = 1; i <= 24; i++) {
            const seatElement = document.getElementById(`seat-${i}`);
            const nameElement = document.getElementById(`name-${i}`);
            const pronounsElement = document.getElementById(`pronouns-${i}`); // ← MOVED TO TOP
            const seatLabel = nameElement ? nameElement.parentElement : null; // ← MOVED TO TOP
            
            if (!seatElement || !nameElement) continue;
            
            let playerInSeat = null;
            for (let playerId in gameState.players) {
                const player = gameState.players[playerId];
                if (player.seat === i && player.status === 'active') {
                    playerInSeat = player;
                    break;
                }
            }

            if (playerInSeat) {
                seatElement.classList.remove('empty');
                seatElement.classList.add('active');

                // ✅ ALWAYS update name if not showing vote
                if (!nameElement.dataset.showingVote) {
                    nameElement.textContent = playerInSeat.name || 'Unknown';
                    nameElement.style.color = '#fff';
                    nameElement.style.fontSize = _nameFontSize();
                    nameElement.style.fontFamily = 'Arial, sans-serif'; // ← Normal font for names
                    console.log(`✅ Updated seat ${i} with name: ${playerInSeat.name}`);
                }

                if (seatLabel && !seatLabel.dataset.showingVote) {
                    // Preserve CoT label visibility if this seat is the active CoT seat
                    const _wasCotHidden = seatElement.dataset.cotActive && seatLabel.style.visibility === 'hidden';
                    // Reset only the background/border set during vote display.
                    // Using cssText='' wipes ALL inline styles, causing a layout flash.
                    seatLabel.style.background = '';
                    seatLabel.style.border = '';
                    seatLabel.style.color = ''; // Reset background
                    if (_wasCotHidden) seatLabel.style.visibility = 'hidden';
                }
                
                // Update pronouns display (SINGLE UPDATE - no flashing)
                if (pronounsElement && !pronounsElement.dataset.showingVote) {
                    const newPronounsText = (playerInSeat.pronouns && playerInSeat.pronouns.trim() !== '') 
                        ? playerInSeat.pronouns 
                        : 'pronouns';
                    
                    // ONLY update if the text actually changed
                    if (pronounsElement.textContent !== newPronounsText) {
                        pronounsElement.textContent = newPronounsText;
                        
                        if (playerInSeat.pronouns && playerInSeat.pronouns.trim() !== '') {
                            pronounsElement.style.opacity = '0.7';
                        } else {
                            pronounsElement.style.opacity = '0.4';
                        }
                        
                        pronounsElement.style.visibility = 'visible';
                        pronounsElement.style.display = 'block';
                        
                        console.log(`✅ Updated pronouns for seat ${i}: ${newPronounsText}`);
                    }
                }
                
                // Make entire seat label clickable if it's the current user's seat
                if ((currentUser.role === 'player' && playerInSeat.id === currentUser.id) || 
                    (currentUser.role === 'host' && i === 1)) {
                    // Explicitly remove and prevent onclick from individual elements
                    nameElement.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        return false;
                    };
                    nameElement.removeAttribute('onclick');
                    nameElement.style.pointerEvents = 'none'; // Make name element non-clickable
                    
                    if (pronounsElement) {
                        pronounsElement.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            return false;
                        };
                        pronounsElement.removeAttribute('onclick');
                        pronounsElement.style.pointerEvents = 'none'; // Make pronouns element non-clickable
                    }
                    
                    // Add onclick to the entire label box
                    if (seatLabel) {
                        seatLabel.style.cursor = 'pointer';
                        seatLabel.onclick = (e) => {
                            e.stopPropagation(); // Prevent seat click
                            // Issue 9: route to Circle of Truth if selection mode active
                            if (window.circleOfTruthSelectionMode && playerInSeat && !playerInSeat.isHost) {
                                if (typeof window.selectPlayerForCircleOfTruth === 'function') {
                                    window.selectPlayerForCircleOfTruth(i, {...playerInSeat, id: Object.keys(gameState.players || {}).find(k => gameState.players[k].seat === i)});
                                }
                                window.circleOfTruthSelectionMode = false;
                                document.querySelectorAll('.video-seat').forEach(s => { s.style.cursor = ''; s.style.border = ''; });
                                return;
                            }
                            editNameAndPronouns(i);
                        };
                    }
                } else {
                    // Clear onclick handlers
                    nameElement.onclick = null;
                    if (seatLabel) {
                        seatLabel.style.cursor = 'default';
                        seatLabel.onclick = null;
                    }
                }
                
                // Update seat display for video/room status
                updateSeatDisplay(i, playerInSeat);
                // Show controls only for current user's seat
                const controls = document.getElementById(`controls-${i}`);
                if (controls) {
                    if ((currentUser.role === 'player' && playerInSeat.id === currentUser.id) || 
                        (currentUser.role === 'host' && i === 1)) {
                        controls.style.display = 'flex';
                    } else {
                        controls.style.display = 'none';
                    }
                }
            } else if (!window._regeneratingSeats) {
                // Skip clearing to 'Empty' while seats are being rebuilt —
                // avoids the visual flicker where occupied seats flash as empty
                seatElement.classList.add('empty');
                seatElement.classList.remove('active');
                // Remove disconnect icon — seat is now empty
                _hideDisconnectIcon(i);
                // Always clear vote-display inline styles on empty seats so the
                // CSS defaults take over cleanly. This prevents a font/size flash
                // when a seat transitions from occupied-with-vote to empty.
                nameElement.style.fontFamily = '';
                nameElement.style.fontSize   = '';
                nameElement.style.color      = '';
                nameElement.style.textAlign  = '';
                nameElement.style.visibility = '';
                nameElement.style.display    = '';
                delete nameElement.dataset.showingVote;
                nameElement.textContent = 'Empty';
                nameElement.onclick = null;

                // Clear pronouns for empty seats
                if (pronounsElement) {
                    pronounsElement.textContent = '';
                }
                // Hide controls for empty seats
                const controls = document.getElementById(`controls-${i}`);
                if (controls) {
                    controls.style.display = 'none';
                }
                // Clear mute indicator for empty seats - FORCE clear
                const muteIndicator = document.getElementById(`mute-${i}`);
                if (muteIndicator) {
                    muteIndicator.style.display = 'none';
                    muteIndicator.textContent = '';
                    muteIndicator.style.visibility = 'hidden';
                }
                // Detach any lingering video feed from this now-empty seat
                _lkDetachSeat(i, true);
                // Remove any name-overlay left by updateSeatDisplay (e.g. 'Laptop - Kitchen')
                const _emptyVid = document.getElementById('video-' + i);
                if (_emptyVid) {
                    const _overlay = _emptyVid.querySelector('.name-overlay');
                    if (_overlay) _overlay.remove();
                }
            }
        }
    }

    // NOTE: Vote tally listeners (game/firstVote/originalVotes and game/firstVote/votes)
    // are registered in the VOTE TALLY LISTENERS section earlier in setupFirebaseListeners
    // (around lines 1210 and 1243). The duplicate block that was here was removed to
    // prevent double-firing which caused the "runaway listener" storm in production.

// Listen for revealed votes during reveal phase
database.ref('game/revealedVoteDisplay').on('child_added', (snapshot) => {
    const data = snapshot.val();
    if (data && data.seat && data.votedFor) {
        console.log('🎯 Vote revealed:', data);
        showVoteOnNameTag(data.seat, data.votedFor, false);
        if (data.timestamp && Date.now() - data.timestamp < 10000) {
            document.getElementById('vote-big-reveal-text')?.remove();
            const _el = document.createElement('div');
            _el.id = 'vote-big-reveal-text';
            _el.textContent = (data.votedFor || '').toUpperCase();
            _el.style.cssText = 'position:fixed;top:100px;left:50%;transform:translateX(-50%);font-size:5rem;font-weight:900;color:white;text-shadow:0 0 40px rgba(255,255,255,0.4);background:rgba(0,0,0,0.55);padding:10px 36px;border-radius:14px;border:2px solid rgba(255,255,255,0.35);z-index:9500;opacity:0;transition:opacity 0.5s;pointer-events:none;text-align:center;white-space:nowrap;letter-spacing:0.06em;text-transform:uppercase;';
            document.body.appendChild(_el);
            setTimeout(() => { _el.style.opacity = '1'; }, 10);
            setTimeout(() => { _el.style.opacity = '0'; }, 3000);
            setTimeout(() => { _el.remove(); }, 3500);
        }
    }
});

// HOST ONLY: Update the "Reveal Count" tally panel as first votes are revealed.
// NOTE: There are intentionally TWO .on('value') listeners on game/revealedVoteDisplay —
// this one (host, updates #reveal-count) and the one below (player, updates
// #first-vote-tally-content). They serve different roles and different DOM elements.
// Do NOT remove one thinking it is a duplicate of the other.
database.ref('game/revealedVoteDisplay').on('value', (snapshot) => {
    if (currentUser.role !== 'host') return;

    // Null guard: when revealedVoteDisplay is removed (e.g. by Check Results),
    // do NOT clear the tally. Only Reset All Votes / Reset Game should clear it.
    if (!snapshot.val()) return;

    const revealedVotes = snapshot.val() || {};
    const revealCountElement = document.getElementById('reveal-count');
    
    if (!revealCountElement) return;
    
    // Count revealed votes by seat
    const revealCounts = {};
    for (let voterId in revealedVotes) {
        const voteData = revealedVotes[voterId];
        if (voteData && voteData.votedFor) {
            revealCounts[voteData.votedFor] = (revealCounts[voteData.votedFor] || 0) + 1;
        }
    }

    if (Object.keys(revealCounts).length === 0) return; // no data — leave tally alone
    
    revealCountElement.innerHTML = '';
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
    let colorIndex = 0;
    
    for (let seat in revealCounts) {
        const player = Object.values(gameState.players).find(p => p.seat === parseInt(seat));
        const name = player ? player.name : `Seat ${seat}`;
        const count = revealCounts[seat];
        const color = colors[colorIndex % colors.length];
        
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 10px;
            margin: 5px 0;
            background: rgba(255,255,255,0.1);
            border-radius: 5px;
            color: ${color};
            font-weight: bold;
        `;
        item.textContent = `${name}: ${count} vote${count > 1 ? 's' : ''}`;
        revealCountElement.appendChild(item);
        
        colorIndex++;
    }
});

// PLAYER ONLY: Update the first-vote tally panel as votes are revealed.
// NOTE: This is intentionally a second .on('value') listener on game/revealedVoteDisplay.
// The listener above handles the HOST tally (#reveal-count).
// This one handles the PLAYER tally (#first-vote-tally-content).
// Both must exist — they update different DOM elements for different roles.
database.ref('game/revealedVoteDisplay').on('value', (snapshot) => {
    if (currentUser.role !== 'player') return;

    // When revealedVoteDisplay is removed (null) — e.g. after Check Results —
    // do NOT reset the tally. Only update when there's actual data to show.
    // Tallies should only be cleared by Reset Game or Reset All Votes.
    if (!snapshot.val()) return;
    
    // Check if we're in second vote reveal
    database.ref('game/secondVoteReveal/active').once('value', (revoteSnap) => {
        const inSecondVoteReveal = revoteSnap.val() === true;
        
        // If we're in second vote reveal, don't update - let the firstVote listener handle it
        if (inSecondVoteReveal) {
            console.log('⏭️ In second vote reveal - first vote listener will handle display');
            return;
        }
        
        // We're in first vote reveal - show the tally as votes are revealed
        const revealedVotes = snapshot.val() || {};
        const revealCountElement = document.getElementById('first-vote-tally-content');
        
        if (!revealCountElement) {
            console.log('⚠️ PLAYER: vote-tally-content element not found');
            return;
        }
        
        const revealCounts = {};
        for (let voterId in revealedVotes) {
            const voteData = revealedVotes[voterId];
            if (voteData && voteData.votedFor) {
                revealCounts[voteData.votedFor] = (revealCounts[voteData.votedFor] || 0) + 1;
            }
        }
        
        if (Object.keys(revealCounts).length === 0) return; // no data — leave tally alone
        
        revealCountElement.innerHTML = '';
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
        let colorIndex = 0;
        const sortedNames = Object.keys(revealCounts).sort((a, b) => revealCounts[b] - revealCounts[a]);
        
        for (let name of sortedNames) {
            const count = revealCounts[name];
            const color = colors[colorIndex % colors.length];
            const item = document.createElement('div');
            item.style.cssText = `padding: 10px; margin: 5px 0; background: rgba(255,255,255,0.1); border-radius: 5px; color: ${color}; font-weight: bold;`;
            item.textContent = `${name}: ${count} vote${count > 1 ? 's' : ''}`;
            revealCountElement.appendChild(item);
            colorIndex++;
        }
        
        console.log('📊 PLAYER: First vote reveal counts displayed:', revealCounts);
    });
});

// PLAYER: Listen to firstVote/votes to keep first vote tally visible during second vote reveal
database.ref('game/firstVote/votes').on('value', (snapshot) => {
    if (currentUser.role !== 'player') return;
    
    // Only show this during second vote reveal
    database.ref('game/secondVoteReveal/active').once('value', (revoteSnap) => {
        if (revoteSnap.val() !== true) return; // Only run during second vote reveal
        
        const votes = snapshot.val() || {};
        
        // Show the second vote tally section
        const secondVoteTallySection = document.getElementById('second-vote-tally');
        if (secondVoteTallySection) {
            secondVoteTallySection.style.display = 'block';
        }

        const revealCountElement = document.getElementById('second-vote-tally-content');
        
        if (!revealCountElement) return;
        
        // Count the votes
        const voteCounts = {};
        Object.values(votes).forEach(votedSeat => {
            // Get player name from seat
            database.ref('players').once('value', (playersSnap) => {
                const players = playersSnap.val() || {};
                let votedName = `Seat ${votedSeat}`;
                
                for (let id in players) {
                    if (players[id].seat === votedSeat) {
                        votedName = players[id].name;
                        break;
                    }
                }
                
                voteCounts[votedName] = (voteCounts[votedName] || 0) + 1;
                
                // Update display
                revealCountElement.innerHTML = '';
                const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
                let colorIndex = 0;
                const sortedNames = Object.keys(voteCounts).sort((a, b) => voteCounts[b] - voteCounts[a]);
                
                for (let name of sortedNames) {
                    const count = voteCounts[name];
                    const color = colors[colorIndex % colors.length];
                    const item = document.createElement('div');
                    item.style.cssText = `padding: 10px; margin: 5px 0; background: rgba(255,255,255,0.1); border-radius: 5px; color: ${color}; font-weight: bold;`;
                    item.textContent = `${name}: ${count} vote${count > 1 ? 's' : ''}`;
                    revealCountElement.appendChild(item);
                    colorIndex++;
                }
            });
        });
        
        console.log('📊 PLAYER: Keeping first vote tally visible during second vote reveal');
    });
});

// PLAYER & HOST: Listen for SECOND VOTE reveals and display on name tags AND tally
database.ref('game/secondVoteReveal/revealedVotes').on('value', (snapshot) => {
    // When secondVoteReveal is removed (e.g. by Check Results), snapshot.val() is null.
    // Do NOT clear the tally — tallies only clear on Reset All Votes, Reset Game, or Night phase.
    if (!snapshot.val()) return;

    const revealedVotes = snapshot.val() || {};
    
    console.log('🎯 SECOND VOTE REVEALS updated:', revealedVotes);
    
    // PART 1: Display each revealed vote on name tags
    Object.entries(revealedVotes).forEach(([playerId, voteData]) => {
        if (voteData && voteData.seat && voteData.votedFor) {
            console.log(`📝 Showing second vote reveal: Seat ${voteData.seat} → ${voteData.votedFor}`);
            showVoteOnNameTag(voteData.seat, voteData.votedFor, false);
        }
    });
    
    // PART 2: Update vote tally (players only)
    if (currentUser.role === 'player') {
        // Show the second vote tally section
        const secondVoteTallySection = document.getElementById('second-vote-section');
        if (secondVoteTallySection) {
            secondVoteTallySection.style.display = 'block';
        }

        const revealCountElement = document.getElementById('second-vote-tally-content');

        if (!revealCountElement) {
            console.log('⚠️ PLAYER: second-vote-tally-content element not found');
            return;
        }
        
        const revealCounts = {};
        for (let voterId in revealedVotes) {
            const voteData = revealedVotes[voterId];
            if (voteData && voteData.votedFor) {
                revealCounts[voteData.votedFor] = (revealCounts[voteData.votedFor] || 0) + 1;
            }
        }
        
        revealCountElement.innerHTML = '';
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
        let colorIndex = 0;
        const sortedNames = Object.keys(revealCounts).sort((a, b) => revealCounts[b] - revealCounts[a]);
        
        for (let name of sortedNames) {
            const count = revealCounts[name];
            const color = colors[colorIndex % colors.length];
            const item = document.createElement('div');
            item.style.cssText = `padding: 10px; margin: 5px 0; background: rgba(255,255,255,0.1); border-radius: 5px; color: ${color}; font-weight: bold;`;
            item.textContent = `${name}: ${count} vote${count > 1 ? 's' : ''}`;
            revealCountElement.appendChild(item);
            colorIndex++;
        }
        
        console.log('📊 PLAYER: Second vote reveal counts displayed:', revealCounts);
    }
})

// Second vote big text — child_added fires once per new entry
database.ref('game/secondVoteReveal/revealedVotes').on('child_added', (snapshot) => {
    const voteData = snapshot.val();
    if (!voteData || !voteData.votedFor) return;
    if (voteData.timestamp && Date.now() - voteData.timestamp > 10000) return;
    document.getElementById('vote-big-reveal-text')?.remove();
    const _el = document.createElement('div');
    _el.id = 'vote-big-reveal-text';
    _el.textContent = (voteData.votedFor || '').toUpperCase();
    _el.style.cssText = 'position:fixed;top:100px;left:50%;transform:translateX(-50%);font-size:5rem;font-weight:900;color:white;text-shadow:0 0 40px rgba(255,255,255,0.4);background:rgba(0,0,0,0.55);padding:10px 36px;border-radius:14px;border:2px solid rgba(255,255,255,0.35);z-index:9500;opacity:0;transition:opacity 0.5s;pointer-events:none;text-align:center;white-space:nowrap;letter-spacing:0.06em;text-transform:uppercase;';
    document.body.appendChild(_el);
    setTimeout(() => { _el.style.opacity = '1'; }, 10);
    setTimeout(() => { _el.style.opacity = '0'; }, 3000);
    setTimeout(() => { _el.remove(); }, 3500);
});;

// ============================================
// ANNOUNCEMENTS
// ============================================

function showAnnouncement(text) {
    // Create temporary announcement overlay
    const announcement = document.createElement('div');
    announcement.style.position = 'fixed';
    announcement.style.top = '20px';
    announcement.style.left = '50%';
    announcement.style.transform = 'translateX(-50%)';
    announcement.style.background = 'rgba(255, 107, 107, 0.95)';
    announcement.style.padding = '20px 40px';
    announcement.style.borderRadius = '10px';
    announcement.style.fontSize = '1.5rem';
    announcement.style.fontWeight = 'bold';
    announcement.style.zIndex = '9999';
    announcement.style.boxShadow = '0 5px 30px rgba(0,0,0,0.5)';
    announcement.textContent = text;
    
    document.body.appendChild(announcement);
    
    // Remove after 5 seconds
    setTimeout(() => {
        announcement.remove();
    }, 5000);
}

// ============================================
// INITIALIZE ON PAGE LOAD
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initializeGame();
});

// ============================================
// SEAT DISPLAY
// ============================================

// Update seat display based on video/room status
function updateSeatDisplay(seatNumber, playerData) {
    const videoDiv = document.getElementById(`video-${seatNumber}`);
    if (!videoDiv) return;
    
    // Check if player is in different room
    // 'waiting' is an internal state, not a displayable room
    // During night/breakfast, overlay handles display — don't show room labels
    const _currentPhase = window._currentPhase || (gameState && gameState.phase);
    const _overlayActive = (_currentPhase === 'night' || _currentPhase === 'breakfast');
    const isInDifferentRoom = !_overlayActive &&
        playerData.room && playerData.room !== 'main' && playerData.room !== 'waiting';
    
    // Check if video is off (we'll track this in Firebase)
    const isVideoOff = playerData.videoOff === true;
    
    if (isVideoOff || isInDifferentRoom) {
        // Show name overlay
        let overlayText = `<div style="font-size: 1.2rem; font-weight: bold;">${playerData.name}</div>`;
        
        if (isInDifferentRoom) {
            const roomNames = {
                'kitchen': 'Kitchen',
                'library': 'Library',
                'living': 'Living Room',
                'courtyard': 'Courtyard',
                'bathroom': 'Bathroom',
                'gym': 'Gym',
                'turret': 'Turret',
                'lobby': 'Lobby'
            };
            overlayText += `<div style="font-size: 0.9rem; margin-top: 5px; color: #bbb;">${roomNames[playerData.room] || playerData.room}</div>`;
        }
        
        // Create or update overlay
        let overlay = videoDiv.querySelector('.name-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'name-overlay';
            overlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                background: rgba(0, 0, 0, 0.8);
                border-radius: 50%;
                color: white;
                z-index: 10;
                pointer-events: none;
            `;
            videoDiv.appendChild(overlay);
        }
        overlay.innerHTML = overlayText;
    } else {
        // Remove overlay if it exists
        const overlay = videoDiv.querySelector('.name-overlay');
        if (overlay) overlay.remove();
    }
}

// ============================================
// PLAYER RENAME FUNCTION
// ============================================

// Rename functionality - called when clicking own name
function renameSelf() {
    // Redirect to new modal-based editing
    editNameAndPronouns(currentUser.seat);
}

// Real-time resize handler
let resizeTimeout;
let lastWidth = window.innerWidth;
let lastHeight = window.innerHeight;

window.addEventListener('resize', () => {
    // Don't regenerate if page is hidden/tab is not visible
    if (document.hidden) {
        console.log('⏭️ Skipping resize - page is hidden');
        return;
    }
    
    // Don't regenerate during active gameplay phases (prevents DevTools console resizes)
    database.ref('game/phase').once('value', (phaseSnap) => {
        const currentPhase = phaseSnap.val();
        if (currentPhase === 'breakfast' || currentPhase === 'voting' || currentPhase === 'vote-reveal') {
            console.log(`⏭️ Skipping resize during ${currentPhase} phase - active gameplay`);
            return;
        }
        
        clearTimeout(resizeTimeout);
        
        resizeTimeout = setTimeout(() => {
            // Double-check page is still visible
            if (document.hidden) {
                console.log('⏭️ Skipping delayed resize - page became hidden');
                return;
            }
            
            // Only regenerate if dimensions actually changed significantly
            const currentWidth = window.innerWidth;
            const currentHeight = window.innerHeight;
            
            // Require at least 100px change to regenerate (filters out DevTools panel)
            const widthDiff = Math.abs(currentWidth - lastWidth);
            const heightDiff = Math.abs(currentHeight - lastHeight);
            
            if (widthDiff < 100 && heightDiff < 100) {
                console.log(`⏭️ Skipping resize - change too small (${widthDiff}px x ${heightDiff}px)`);
                return;
            }
            
            console.log(`Window resized: ${lastWidth}x${lastHeight} → ${currentWidth}x${currentHeight}`);
            lastWidth = currentWidth;
            lastHeight = currentHeight;

            // PRESERVE VIDEO ELEMENTS before regenerating
            // Must move live DOM nodes — innerHTML loses the MediaStream srcObject
            const videoNodes = {};
            for (let i = 1; i <= 25; i++) {
                const videoDiv = document.getElementById(`video-${i}`);
                if (videoDiv && videoDiv.children.length > 0) {
                    const frag = document.createDocumentFragment();
                    while (videoDiv.firstChild) frag.appendChild(videoDiv.firstChild);
                    videoNodes[i] = frag;
                }
            }
            
            generateVideoSeats(); // Regenerate with new dimensions

            // Night/breakfast seat re-hiding is handled inside generateVideoSeats() itself.

            // Immediately restore player names to avoid 'Empty' flash during resize
            for (const pid in gameState.players) {
                const _pp = gameState.players[pid];
                if (!_pp.seat || typeof _pp.seat !== 'number') continue;
                const _nameEl = document.getElementById('name-' + _pp.seat);
                if (_nameEl && _nameEl.textContent === 'Empty') {
                    _nameEl.textContent = _pp.name || 'Empty';
                    const _pronEl = document.getElementById('pronouns-' + _pp.seat);
                    if (_pronEl && _pp.pronouns) _pronEl.textContent = _pp.pronouns;
                    const _seatEl = document.getElementById('seat-' + _pp.seat);
                    if (_seatEl) { _seatEl.classList.remove('empty'); _seatEl.classList.add('active'); }
                }
            }
            
            // RESTORE VIDEO ELEMENTS after regenerating
            setTimeout(() => {
                for (let seat in videoNodes) {
                    const videoDiv = document.getElementById(`video-${seat}`);
                    if (videoDiv) {
                        videoDiv.innerHTML = '';
                        videoDiv.appendChild(videoNodes[seat]);
                        // Re-trigger autoplay since video element moved to new DOM position
                        const vid = videoDiv.querySelector('video');
                        if (vid && vid.paused && vid.srcObject) {
                            vid.play().catch(() => {});
                        }
                    }
                }
                console.log('✅ Video elements preserved through resize');
                // AV buttons are CSS-positioned — no repositioning needed after resize
                // Re-apply mute/cam-off icons (seat HTML was rebuilt, so icons reset)
                if (typeof window._refreshAVIcons === 'function') window._refreshAVIcons();
                // Re-scan LiveKit participants to reattach any video that wasn't preserved
                const _lkRoomRef = window._lkRoom;
                if (_lkRoomRef) {
                    _lkRoomRef.remoteParticipants.forEach(async (participant) => {
                        const seat = await _lkIdentityToSeat(participant.identity, true);
                        if (!seat) return;
                        const container = document.getElementById('video-' + seat);
                        if (!container || container.querySelector('.lk-video')) return;
                        participant.trackPublications.forEach((pub) => {
                            if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                                _lkAttachVideo(pub.track, seat, true, 0, false, participant.identity);
                                console.log('📹 Post-resize reattach:', participant.identity, '→ video-' + seat);
                            }
                        });
                    });
                    // Also reattach own video if it was lost
                    const _u = _lkCurrentUser ? _lkCurrentUser() : window.currentUser;
                    if (_u && _u.seat) {
                        const _ownDiv = document.getElementById('video-' + _u.seat);
                        if (_ownDiv && !_ownDiv.querySelector('.lk-video')) {
                            _lkRoomRef.localParticipant.trackPublications.forEach((pub) => {
                                if (pub.kind === LivekitClient.Track.Kind.Video && pub.track) {
                                    _lkAttachVideo(pub.track, _u.seat, true, 0, true);
                                    console.log('📹 Post-resize reattach own video → video-' + _u.seat);
                                }
                            });
                        }
                    }
                }
                // Re-apply Circle of Truth red glow if still active (host-only)
                if (window._cotTargetSeat) {
                    const _cotSeat = document.getElementById('seat-' + window._cotTargetSeat);
                    if (_cotSeat) {
                        _cotSeat.style.boxShadow = '0 0 40px 15px rgba(255, 0, 0, 0.85)';
                        _cotSeat.style.border = '4px solid #ff0000';
                        _cotSeat.dataset.cotTarget = 'true';
                    }
                }
            }, 10);
            
            // Re-setup player controls after resize regenerates seats
            if (typeof currentUser !== 'undefined' && currentUser.role === 'player' && currentUser.seat) {
                setTimeout(() => {
                    if (typeof setupPlayerControls === 'function') {
                        setupPlayerControls(currentUser.seat);
                    }
                    if (typeof showPlayerControls === 'function') {
                        showPlayerControls();
                    }
                }, 100);
            }

            // Also regenerate room overlay if active
            const overlay = document.getElementById('room-overlay');
            if (overlay && overlay.style.display === 'block' && window.currentUser && window.currentUser.room && window.currentUser.room !== 'main') {
                // Preserve live video nodes before regenerating room seats
                const roomVideoNodes = {};
                for (let s = 1; s <= 10; s++) {
                    const vd = document.getElementById('room-video-' + s);
                    if (vd && vd.children.length > 0) {
                        const frag = document.createDocumentFragment();
                        while (vd.firstChild) frag.appendChild(vd.firstChild);
                        roomVideoNodes[s] = frag;
                    }
                }
                database.ref('game/roomLimits/' + window.currentUser.room).once('value', (snap) => {
                    const limit = snap.val() || 5;
                    generateRoomSeats(window.currentUser.room, limit);
                    // Restore video nodes after regeneration
                    setTimeout(() => {
                        for (const s in roomVideoNodes) {
                            const vd = document.getElementById('room-video-' + s);
                            if (vd) {
                                vd.innerHTML = '';
                                vd.appendChild(roomVideoNodes[s]);
                                const vid = vd.querySelector('video');
                                if (vid && vid.paused && vid.srcObject) vid.play().catch(() => {});
                            }
                        }
                        console.log('✅ Room video nodes preserved through resize');
                        // Re-attach any tracks that didn't survive
                        const lkRoom = window._lkRoom;
                        if (lkRoom) {
                            lkRoom.remoteParticipants.forEach(async (participant) => {
                                const seat = await _lkIdentityToSeat(participant.identity, false);
                                if (!seat) return;
                                participant.trackPublications.forEach((pub) => {
                                    if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                                        const vd2 = document.getElementById('room-video-' + seat);
                                        if (!vd2 || vd2.children.length === 0) {
                                            _lkAttachVideo(pub.track, seat, false, 0);
                                        }
                                    }
                                });
                            });
                        }
                    }, 50);
                });
            }
        }, 50); // Debounce for 250ms
    });
});

// Make rename available globally
window.renameSelf = renameSelf;

function updateSingleMuteIcon(seatNumber, isMuted) {
    if (!seatNumber) return;
    
    const seatElement = document.getElementById(`seat-${seatNumber}`);
    if (!seatElement || seatElement.classList.contains('empty')) return;
    
    let muteIcon = seatElement.querySelector('.muted-indicator');
    
    if (isMuted) {
        if (!muteIcon) {
            muteIcon = document.createElement('div');
            muteIcon.className = 'muted-indicator';
            muteIcon.textContent = '🎤';
            muteIcon.title = 'Muted';
            seatElement.appendChild(muteIcon);
        }
    } else {
        if (muteIcon) {
            muteIcon.remove();
        }
    }
}

function updateMuteIcons() {
    database.ref('game/muteAllPlayers').once('value', (muteAllSnapshot) => {
        const allMuted = muteAllSnapshot.val();
        
        database.ref('players').once('value', (playersSnapshot) => {
            // Update all player seats
            for (let i = 1; i <= 25; i++) {
                const seatElement = document.getElementById(`seat-${i}`);
                if (seatElement && !seatElement.classList.contains('empty')) {
                    let muteIcon = seatElement.querySelector('.muted-indicator');
                    
                    // Check if this specific player is muted
                    let isMuted = false;
                    
                    // Check host mute-all (excludes host seat #1)
                    if (allMuted && i !== 1) {
                        isMuted = true;
                    }
                    
                    // Check individual player mute
                    const player = Object.values(playersSnapshot.val() || {}).find(p => p.seat === i);
                    if (player && player.audioMuted) {
                        isMuted = true;
                    }
                    
                    if (isMuted) {
                        if (!muteIcon) {
                            muteIcon = document.createElement('div');
                            muteIcon.className = 'muted-indicator';
                            muteIcon.textContent = '🎤';
                            muteIcon.title = 'Muted';
                            seatElement.appendChild(muteIcon);
                        }
                    } else {
                        if (muteIcon) {
                            muteIcon.remove();
                        }
                    }
                }
            }
        });
    });
}

// Listen for role reveals (show on all clients)
database.ref('game/roleReveal').on('value', (snapshot) => {
    const reveal = snapshot.val();
    console.log('🎭 Role reveal listener fired:', reveal);
    
    if (!reveal) {
        console.log('⏹️ No role reveal data, returning');
        return;
    }
    
    // Ignore stale role reveals (older than 10 seconds)
    const now = Date.now();
    const age = now - reveal.timestamp;
    
    if (age > 10000) {
        console.log('⏭️ Ignoring stale role reveal (age:', age, 'ms)');
        return;
    }
    
    // Hide ALL THREE phase/timer elements
    const phaseEl = document.getElementById('phase-name');
    const timerPhaseEl = document.getElementById('timer-phase-display');
    const timerEl = document.getElementById('timer');

    if (phaseEl) {
        phaseEl.style.setProperty('display', 'none', 'important');
        phaseEl.style.setProperty('visibility', 'hidden', 'important');
        console.log('✅ Force-hid phase-name');
    }
    if (timerPhaseEl) {
        timerPhaseEl.style.setProperty('display', 'none', 'important');
        timerPhaseEl.style.setProperty('visibility', 'hidden', 'important');
        console.log('✅ Force-hid timer-phase-display');
    }
    if (timerEl) {
        timerEl.style.setProperty('display', 'none', 'important');
        timerEl.style.setProperty('visibility', 'hidden', 'important');
        console.log('✅ Force-hid timer');
    }
    if (timerEl) {
        timerEl.style.display = 'none';
        console.log('✅ Set timer display to none');
    }
    
    // Show role text in place of the phase name
    const roleColor = reveal.role === 'faithful' ? '#4169E1' : '#DC143C'; // blue or red
    const roleText = reveal.role === 'faithful' ? 'Faithful' : 'Traitor';
    
    console.log('🎨 Creating role reveal text:', roleText, 'in color:', roleColor);

    // DIAGNOSTIC: Find all elements that might show phase text
    const allPhaseElements = document.querySelectorAll('[id*="phase"], .phase-name, .game-phase, h1');
    console.log('🔍 FOUND', allPhaseElements.length, 'potential phase elements:');
    allPhaseElements.forEach((el, i) => {
        console.log(`  ${i + 1}. Tag: ${el.tagName}, ID: ${el.id}, Class: ${el.className}, Text: "${el.textContent}"`);
    });
    
    // Create the role reveal text element
    const existing = document.getElementById('role-reveal-text');
    if (existing) {
        console.log('🗑️ Removing existing role reveal text');
        existing.remove();
    }
    
    const roleEl = document.createElement('div');
    roleEl.id = 'role-reveal-text';
    roleEl.textContent = roleText;
    roleEl.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 8rem;
        font-weight: bold;
        color: ${roleColor};
        text-shadow: 0 0 20px ${roleColor};
        z-index: 500;
        opacity: 0;
        transition: opacity 0.5s;
        pointer-events: none;
    `;
    document.body.appendChild(roleEl);
    console.log('✅ Role reveal element added to page');
    
    // Fade in
    setTimeout(() => { 
        roleEl.style.opacity = '1';
        console.log('✅ Role reveal faded in');
    }, 10);
    
    // Auto-remove after 8 seconds, then restore phase name
    setTimeout(() => {
        console.log('⏱️ 8 seconds elapsed, fading out role reveal');
        roleEl.style.opacity = '0';
        setTimeout(() => {
            console.log('🗑️ Removing role reveal element');
            roleEl.remove();
            
            // Check current phase before restoring
            database.ref('game/phase').once('value', (phaseSnapshot) => {
                const currentPhase = phaseSnapshot.val();
                console.log('📍 Restoring elements, current phase:', currentPhase);
                
                // Restore phase name after delay - remove the !important overrides
                if (phaseEl) {
                    phaseEl.style.removeProperty('display');
                    phaseEl.style.removeProperty('visibility');
                    phaseEl.style.display = 'block';
                    console.log('✅ Phase name restored');
                }
                if (timerPhaseEl) {
                    timerPhaseEl.style.removeProperty('display');
                    timerPhaseEl.style.removeProperty('visibility');
                    timerPhaseEl.style.display = 'block';
                    console.log('✅ Timer-phase-display restored');
                }
                
                // Only restore timer if NOT in lobby or circle-of-truth
                if (timerEl) {
                    timerEl.style.removeProperty('display');
                    timerEl.style.removeProperty('visibility');
                    
                    if (currentPhase === 'lobby' || currentPhase === 'circle-of-truth' || currentPhase === 'night' || currentPhase === 'breakfast') {
                        timerEl.style.display = 'none';
                        console.log('✅ Timer kept hidden (phase:', currentPhase, ')');
                    } else {
                        console.log('✅ Timer element restored');
                    }
                }
            });
        }, 500);
    }, 8000);
});

// NOTE: Host vote-display listener (game/firstVote/votes) is inside
// setupFirebaseListeners() at the VOTE TALLY LISTENERS section.
// The duplicate that was here was removed to prevent double-firing.

// autoVoteDisplay listener moved into setupFirebaseListeners()

// Clear ghost seats when players refresh/disconnect
database.ref('players').on('child_changed', (snapshot) => {
    const player = snapshot.val();
    const playerId = snapshot.key;
    
    // If player went to waiting room but seat is still assigned
    // BUT: Don't clear during Breakfast phase (players invited back keep their seats)
    if (player.room === 'waiting' && player.seat) {
        database.ref('game/phase').once('value', (phaseSnap) => {
            const currentPhase = phaseSnap.val();
            
            // Skip ghost clearing during breakfast - players are supposed to have seats there
            if (currentPhase === 'breakfast') {
                return;
            }
            
            const oldSeat = player.seat;
            database.ref('game/seats/' + oldSeat).once('value', (seatSnap) => {
                if (seatSnap.val() === playerId) {
                    database.ref('game/seats/' + oldSeat).remove();
                    database.ref('players/' + playerId + '/seat').remove();
                    console.log('🧹 Cleared ghost seat', oldSeat, 'for', playerId);
                }
            });
        });
    }
});

// Listen for revote starting - clear all vote displays
database.ref('game/secondVote/active').on('value', (snapshot) => {
    if (snapshot.val() === true) {
        console.log('🔄 Revote started - clearing vote displays');
        // Open pill overlay for second vote (player role only)
        if (typeof currentUser !== 'undefined' && currentUser.role === 'player') {
            // Always open the tied-players pill when secondVote becomes active.
            // No 'already open' guard here — the first-vote pill (all players) may
            // be showing and must be replaced with the correct tied-players version.
            if (typeof window.showVotePillOverlay === 'function' && !window.votePillLocked) {
                window.showVotePillOverlay(true); // true = isRevote, shows tied players only
            }
        }
        
        // Clear all vote displays
        for (let i = 1; i <= 25; i++) {
            const nameElement = document.getElementById(`name-${i}`);
            const pronounsElement = document.getElementById(`pronouns-${i}`);
            const seatLabel = nameElement ? nameElement.parentElement : null;
            
            if (nameElement && nameElement.dataset.showingVote) {
                delete nameElement.dataset.showingVote;
                // Reset vote-display styles: if seat is now empty, remove inline
                // styles so CSS defaults apply. If occupied, set player values.
                if (nameElement.textContent === 'Empty') {
                    nameElement.style.fontFamily = '';
                    nameElement.style.fontSize   = '';
                    nameElement.style.color      = '';
                    nameElement.style.textAlign  = '';
                    nameElement.style.visibility = '';
                    nameElement.style.display    = '';
                } else {
                    nameElement.style.fontFamily = 'Arial, sans-serif';
                    nameElement.style.fontSize   = _nameFontSize();
                    nameElement.style.color      = '#fff';
                    nameElement.style.textAlign  = '';
                    nameElement.style.visibility = '';
                    nameElement.style.display    = '';
                }
            }
            if (pronounsElement && pronounsElement.dataset.showingVote) {
                delete pronounsElement.dataset.showingVote;
                pronounsElement.style.display = '';
                // Reset only vote-display styles on pronouns element.
                pronounsElement.style.visibility = '';
                pronounsElement.style.display    = '';
                pronounsElement.style.color      = '';
            }
            if (seatLabel && seatLabel.dataset.showingVote) {
                delete seatLabel.dataset.showingVote;
                // Reset only the background/border set during vote display.
                // Using cssText='' wipes ALL inline styles, causing a layout flash.
                seatLabel.style.background = '';
                seatLabel.style.border = '';
                seatLabel.style.color = '';
                if (seatLabel.parentElement && seatLabel.parentElement.dataset.cotActive)
                    seatLabel.style.visibility = 'hidden';
            }
        }

        // Remove seat highlights
        document.querySelectorAll('.video-seat').forEach(seat => {
            seat.style.boxShadow = '';
            seat.style.border = '';
        });

        // Clear current revealer
        database.ref('game/firstVote/currentRevealer').remove();
        
        // Force player display update
        updatePlayerDisplay();
    } else {
        // Revote ended — close pill overlay
        if (typeof window.closeVotePillOverlay === 'function') {
            window.closeVotePillOverlay();
        }
    }
});

// Listen for role reveal trigger
database.ref('game/triggerRoleReveal').on('value', (snapshot) => {
    if (!snapshot.val()) return;
    
    database.ref('game/pendingRoleReveal').once('value', (roleSnap) => {
        const roleData = roleSnap.val();
        if (!roleData) return;
        
        // Write to game/roleReveal — this fires the clean listener at line 1880
        database.ref('game/roleReveal').set({
            seatNumber: roleData.seatNumber,
            playerId: roleData.playerId,
            role: roleData.role,
            timestamp: Date.now()
        });
        
        // ADD THE TIMEOUT CODE RIGHT HERE (after the .set() above):
        
        // Return Circle of Truth seat to normal size after 5 seconds
        setTimeout(() => {
            database.ref('game/circleOfTruth').once('value', (circleSnap) => {
                const circle = circleSnap.val();
                if (!circle) return;
                
                const seatElement = document.getElementById(`seat-${circle.seatNumber}`);
                if (seatElement) {
                    seatElement.style.transform = 'translate(-50%, -50%) scale(1.0)';
                    seatElement.style.transition = 'transform 0.5s ease';
                    
                    // Also restore name tag size (skip if CoT is hiding it)
                    const seatLabel = seatElement.querySelector('.seat-label');
                    if (seatLabel && !seatElement.dataset.cotActive) {
                        seatLabel.style.transform = 'scale(1.0)';
                    }
                }
            });
        }, 5000);
        
        // Clean up (existing code continues below)
        database.ref('game/pendingRoleReveal').remove();
        database.ref('players/' + roleData.playerId + '/readyToRevealRole').remove();
        database.ref('game/triggerRoleReveal').remove();
    });
});

function showRoleAnimation(role) {
    const roleText = role.toUpperCase();
    const container = document.createElement('div');
    container.id = 'role-animation-container';
    container.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 5;
        pointer-events: none;
        overflow: hidden;
    `;
    
    // Create 40 flying text elements (doubled from 20)
    for (let i = 0; i < 40; i++) {
        const text = document.createElement('div');
        text.textContent = roleText;
        
        const fontSize = Math.random() * 120 + 40; // 40-160px (much more varied)
        const duration = Math.random() * 3 + 1; // 1-4 seconds (faster range)
        const delay = Math.random() * 1; // 0-1s delay
        const yPos = Math.random() * 100; // Random vertical position
        const color = role === 'faithful' ? '#4169E1' : '#DC143C';
        
        // More font families
        const fonts = ['Arial', 'Impact', 'Georgia', 'Courier New', 'Comic Sans MS', 'Verdana', 'Trebuchet MS', 'Times New Roman', 'Brush Script MT'];
        const font = fonts[Math.floor(Math.random() * fonts.length)];
        
        // Random direction (left or right)
        const direction = Math.random() > 0.5 ? 'flyRight' : 'flyLeft';
        
        // Random rotation
        const rotation = Math.random() * 60 - 30; // -30 to 30 degrees
        
        text.style.cssText = `
            position: absolute;
            ${direction === 'flyRight' ? 'left: -300px;' : 'right: -300px;'}
            top: ${yPos}%;
            font-size: ${fontSize}px;
            font-weight: ${Math.random() > 0.5 ? 'bold' : 'normal'};
            font-style: ${Math.random() > 0.7 ? 'italic' : 'normal'};
            color: ${color};
            font-family: ${font};
            opacity: ${0.6 + Math.random() * 0.4};
            transform: rotate(${rotation}deg);
            animation: ${direction} ${duration}s linear ${delay}s;
            animation-fill-mode: forwards;
        `;
        
        container.appendChild(text);
    }
    
    // Add CSS animations for both directions
    const style = document.createElement('style');
    style.textContent = `
        @keyframes flyRight {
            0% { left: -300px; }
            100% { left: 110%; }
        }
        @keyframes flyLeft {
            0% { right: -300px; }
            100% { right: 110%; }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(container);
    
    // Remove after 4 seconds
    setTimeout(() => {
        container.remove();
        style.remove();
    }, 5000);
}

// Listen for tally clearing signal (Reset All Votes / Reset Game)
database.ref('game/clearTallies').on('value', (snapshot) => {
    if (!snapshot.val()) return;
    // Clear all vote tally displays on all clients
    const _tallyEls = [
        'first-vote-tally-content', 'second-vote-tally-content',
        'original-count', 'current-count', 'reveal-count',
        'revote-count', 'revote-reveal-count'
    ];
    _tallyEls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    const _svSection = document.getElementById('second-vote-tally');
    if (_svSection) _svSection.style.display = 'none';
    const _svSection2 = document.getElementById('second-vote-section');
    if (_svSection2) _svSection2.style.display = 'none';
    console.log('🧹 All vote tallies cleared by signal');
});

// Listen for vote display clearing
database.ref('game/clearVoteDisplays').on('value', (snapshot) => {
    if (!snapshot.val()) return;
    
    console.log('🧹 Clearing all vote displays');
    
    // Clear all vote displays
    for (let i = 1; i <= 25; i++) {
        const nameElement = document.getElementById(`name-${i}`);
        const pronounsElement = document.getElementById(`pronouns-${i}`);
        const seatLabel = nameElement ? nameElement.parentElement : null;
        
        if (nameElement && nameElement.dataset.showingVote) {
            delete nameElement.dataset.showingVote;
            // Reset only vote-display styles on the name element — targeted,
            // not cssText='' which causes a full style recalculation flash.
            nameElement.style.fontFamily = 'Arial, sans-serif';
            nameElement.style.fontSize   = _nameFontSize();
            nameElement.style.color      = '#fff';
            nameElement.style.textAlign  = '';
            nameElement.style.visibility = '';
            nameElement.style.display    = '';
        }
        if (pronounsElement && pronounsElement.dataset.showingVote) {
            delete pronounsElement.dataset.showingVote;
            pronounsElement.style.display = '';
            // Reset only vote-display styles on pronouns element.
            pronounsElement.style.visibility = '';
            pronounsElement.style.display    = '';
            pronounsElement.style.color      = '';
        }
        if (seatLabel && seatLabel.dataset.showingVote) {
            delete seatLabel.dataset.showingVote;
            // Reset only the background/border set during vote display.
            // Using cssText='' wipes ALL inline styles, causing a layout flash.
            seatLabel.style.background = '';
            seatLabel.style.border = '';
            seatLabel.style.color = '';
            if (seatLabel.parentElement && seatLabel.parentElement.dataset.cotActive)
                seatLabel.style.visibility = 'hidden';
        }
    }
    
    // Force player display update
    updatePlayerDisplay();
});

// Force hide seats when in waiting room, even if arrangement changes
database.ref('game/roomLimits/main').on('value', () => {
    if (currentUser && currentUser.role === 'player' && currentUser.room === 'waiting') {
        // Player is in waiting room - seats should be hidden
        setTimeout(() => {
            document.querySelectorAll('.video-seat').forEach(seat => {
                seat.style.display = 'none';
            });
        }, 100);
    }
});

// ============================================
// END GAME — SMOKE REVEAL DISPLAY (all clients)
// ============================================
// smokeReveal handled in End Game block);

// ============================================
// END GAME — BANISHMENT REVEAL (all clients)
// ============================================
// revealedVotes handled in End Game block;

// game/endGame/roleReveal handled in End Game block

// ============================================
// END GAME — WINNERS DISPLAY (all clients)
// ============================================
// NOTE: There are intentionally TWO .on('value') listeners on game/endGame/winners:
//   1. THIS listener (here) — updates the FULL-SCREEN overlay (#endgame-winners-overlay,
//      #winners-team-name, #winners-player-names).
//   2. A second listener near the bottom of the file — updates the PHASE TITLE BAR
//      (#phase-name) and inline names display (#endgame-winners-names-display).
// They serve different DOM elements and must both exist. Do NOT remove one thinking
// it is a duplicate of the other.
database.ref('game/endGame/winners').on('value', (snapshot) => {
    const data = snapshot.val();
    const overlay = document.getElementById('endgame-winners-overlay');
    if (!overlay) return;
    if (!data) { overlay.style.display = 'none'; return; }
    const teamNameEl = document.getElementById('winners-team-name');
    const playerNamesEl = document.getElementById('winners-player-names');
    if (teamNameEl) { teamNameEl.textContent = data.teamLabel || data.teamName || ''; teamNameEl.style.color = data.teamColor || '#FFD700'; }
    if (playerNamesEl) { playerNamesEl.textContent = data.winnerText || ''; playerNamesEl.style.color = data.teamColor || '#FFD700'; }
    overlay.style.display = 'flex';
});
// ── Production Member Seats ──────────────────────────────────────────────────
// Prod members get letter seats (B, C, D...) positioned in the left column
// below the main host seat. Each gets a video circle the same size as player seats.

// _doProdSeatLayout: the actual DOM-layout work for prod seats.
// Called both from the one-time immediate .once() read and from the persistent
// .on('value') listener (which re-uses the last-known resize dimensions).
// Keeping this as a named function means the layout logic is defined once.
function _doProdSeatLayout(hostX, hostY, hostSize, playerSize, leftSectionWidth, snap) {
    const _isHostOrProd = currentUser.role === 'host' || currentUser.isProdMember
                       || currentUser.role === 'observer';
    const _isPlayerView = !_isHostOrProd;
    const FIXED_LETTERS = ['B', 'C', 'D'];
    const _bottomMargin  = 24;
    const _topOfSpace    = hostY + hostSize / 2 + 12;
    const _availHeight   = window.innerHeight - _bottomMargin - _topOfSpace;
    const _nProd         = FIXED_LETTERS.length;
    const _spacing0      = _availHeight / (_nProd + 1);
    const _vw = window.innerWidth;
    const _vh = window.innerHeight;
    const _isProdMobile = _vw <= 600 || (_vh <= 500 && _vw <= 1024);
    let _size;
    if (!_isProdMobile && _vw >= 1200) {
        _size = Math.max(40, Math.min(playerSize, _spacing0 * 0.60, leftSectionWidth - 20));
    } else if (!_isProdMobile) {
        _size = Math.min(40, Math.round(playerSize * 0.40), _spacing0 * 0.45);
        _size = Math.max(24, _size);
    } else {
        _size = Math.min(44, Math.round(playerSize * 0.80), _spacing0 * 0.40);
        _size = Math.max(36, _size);
    }

    const _memberByLetter = {};
    snap.forEach(child => {
        const p = child.val();
        if (p && p.seat && FIXED_LETTERS.includes(p.seat) && p.status !== 'removed') {
            _memberByLetter[p.seat] = p;
        }
    });

    document.querySelectorAll('.prod-seat').forEach(el => {
        const _l = el.id.replace('seat-', '');
        if (!FIXED_LETTERS.includes(_l)) el.remove();
    });

    FIXED_LETTERS.forEach((letter, idx) => {
        const seatId = 'seat-' + letter;
        const member = _memberByLetter[letter] || null;
        const y = _topOfSpace + _spacing0 * (idx + 1);
        const x = hostX;
        const size = _size;

        if (_isPlayerView && !member) {
            const _stale = document.getElementById(seatId);
            if (_stale) _stale.remove();
            return;
        }

        let seatEl = document.getElementById(seatId);
        if (!seatEl) {
            seatEl = document.createElement('div');
            seatEl.id = seatId;
            seatEl.className = 'video-seat prod-seat empty';
            seatEl.innerHTML = `
                <div id="video-${letter}"></div>
                <div class="seat-label" id="seat-label-${letter}">
                    <button class="av-btn mic-btn" id="mic-btn-${letter}" title="Toggle Mic (M)" onclick="event.stopPropagation(); window.toggleMic && window.toggleMic()"><svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></button>
                    <button class="av-btn cam-btn" id="cam-btn-${letter}" title="Toggle Camera (V)" onclick="event.stopPropagation(); window.toggleCam && window.toggleCam()"><svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></button>
                    <span class="player-name" id="name-${letter}" style="font-family:Arial,sans-serif;font-size:1.2rem;color:#fff;">Empty</span>
                    <span class="player-pronouns" id="pronouns-${letter}"></span>
                </div>
                <div class="seat-av-controls" id="av-controls-${letter}" style="display:none"></div>
                <div class="av-status-icons" id="av-status-${letter}">
                    <span class="av-icon mic-off-icon" id="mic-off-${letter}" style="display:none"><svg viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></span>
                    <span class="av-icon cam-off-icon" id="cam-off-${letter}" style="display:none"><svg viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></button></span>
                </div>
                <div class="audio-ring" id="aring-${letter}"></div>
            `;
            if (_isHostOrProd) {
                seatEl.addEventListener('click', (e) => {
                    if (!window.currentUser || !window.currentUser.seat) return;
                    const mySeat = window.currentUser.seat;
                    if (mySeat === letter) return;
                    if (!['A','B','C','D'].includes(String(mySeat))) return;
                    _showSeatSwitchMenu(letter, e.clientX, e.clientY);
                });
            }
            document.body.appendChild(seatEl);
        }

        const _nameEl = document.getElementById('name-' + letter);
        const _pronEl = document.getElementById('pronouns-' + letter);
        if (member) {
            seatEl.classList.remove('empty');
            seatEl.classList.add('active');
            const _sw = window._activeDisplaySwap;
            let _displayName = member.name || letter;
            let _displayPron = member.pronouns || '';
            if (_sw) {
                if (String(letter) === String(_sw.seatA)) { _displayName = _sw.nameB; _displayPron = _sw.pronounsB; }
                else if (String(letter) === String(_sw.seatB)) { _displayName = _sw.nameA; _displayPron = _sw.pronounsA; }
            }
            if (_nameEl) { _nameEl.textContent = _displayName; _nameEl.style.fontFamily = 'Arial, sans-serif'; _nameEl.style.fontSize = _nameFontSize(); _nameEl.style.color = '#fff'; }
            if (_pronEl) _pronEl.textContent = _displayPron;
            if (window.currentUser && window.currentUser.seat === letter && !seatEl._avControlsSetup) {
                seatEl._avControlsSetup = true;
                setTimeout(() => { if (typeof window.setupAVControls === 'function') window.setupAVControls(letter); }, 200);
            }
        } else {
            seatEl.classList.add('empty');
            seatEl.classList.remove('active');
            if (_nameEl) { _nameEl.textContent = 'Empty'; _nameEl.style.fontFamily = ''; _nameEl.style.fontSize = ''; _nameEl.style.color = ''; }
            if (_pronEl) _pronEl.textContent = '';
        }

        seatEl.style.position  = 'fixed';
        seatEl.style.left      = x + 'px';
        seatEl.style.top       = y + 'px';
        seatEl.style.setProperty('width',  size + 'px', 'important');
        seatEl.style.setProperty('height', size + 'px', 'important');
        seatEl.style.transform = 'translate(-50%, -50%)';
    });

    if (window._avIconsListener) { /* force re-evaluation by existing listener */ }
}

function _positionProdSeats(hostX, hostY, hostSize, playerSize, leftSectionWidth) {
    const _isHostOrProd = currentUser.role === 'host' || currentUser.isProdMember
                       || currentUser.role === 'observer';
    const _isPlayerView = !_isHostOrProd; // regular players see occupied seats only

    const FIXED_LETTERS = ['B', 'C', 'D']; // Always exactly 3 prod seats

    // GUARD: This function runs on every window resize. Without the guard below,
    // each resize would stack another persistent .on('value') listener on the players
    // path — causing the players node to fire N callbacks per change after N resizes.
    // Fix: register the persistent listener exactly once and store the latest layout
    // args on window so the callback can re-use them when prod membership changes.
    window._lastProdSeatArgs = { hostX, hostY, hostSize, playerSize, leftSectionWidth };
    if (!window._prodSeatsListenerRegistered) {
        window._prodSeatsListenerRegistered = true;
        database.ref('players').orderByChild('isProdMember').equalTo(true).on('value', (snap) => {
            // When prod membership changes, re-run the layout using the most recent
            // resize dimensions stored above.
            const a = window._lastProdSeatArgs || {};
            _doProdSeatLayout(a.hostX, a.hostY, a.hostSize, a.playerSize, a.leftSectionWidth, snap);
        });
        console.log('✅ _positionProdSeats: persistent players listener registered (once)');
    }
    // Run the layout immediately for the current resize dimensions.
    // All layout logic lives in _doProdSeatLayout (above) — called from both
    // this one-time read AND the persistent .on('value') listener registered above.
    database.ref('players').orderByChild('isProdMember').equalTo(true).once('value', (snap) => {
        _doProdSeatLayout(hostX, hostY, hostSize, playerSize, leftSectionWidth, snap);
    });
}


// ── Seat Switch System ─────────────────────────────────────────────────────
// Production members can swap seats with each other. A switch menu appears
// when clicking another prod/host seat. Target gets a confirmation modal.


// ============================================
// HOST SEAT ACTION MENU
// ============================================
window._hostSeatActionMenu = null;

function _dismissHostActionMenu() {
    if (window._hostSeatActionMenu) {
        window._hostSeatActionMenu.remove();
        window._hostSeatActionMenu = null;
    }
}

function _detectHostActionContext(cb) {
    const phase = (window._currentPhase || '').toLowerCase();
    if (phase === 'circle-of-truth') { cb({ mode: 'role', roleType: 'cot' }); return; }

    database.ref('game/endGame').once('value', (egSnap) => {
        const eg = egSnap.val() || {};
        if (eg.finalReveal && eg.finalReveal.active)                           { cb({ mode: 'role',   roleType: 'final'         }); return; }
        if (eg.smokeVote   && eg.smokeVote.revealActive)                       { cb({ mode: 'reveal', voteKey: 'smoke'           }); return; }
        if (eg.smokeVote   && eg.smokeVote.active && !eg.smokeVote.revealActive){ cb({ mode: 'vote',   voteKey: 'smoke'           }); return; }
        if (eg.banishmentTie && eg.banishmentTie.revealed)                     { cb({ mode: 'reveal', voteKey: 'banishmentTie'   }); return; }
        if (eg.banishmentTie && eg.banishmentTie.active && !eg.banishmentTie.revealed){ cb({ mode: 'vote', voteKey: 'banishmentTie'}); return; }
        if (eg.banishment  && eg.banishment.revealed)                          { cb({ mode: 'reveal', voteKey: 'banishment'      }); return; }
        if (eg.banishment  && eg.banishment.active && !eg.banishment.revealed) { cb({ mode: 'vote',   voteKey: 'banishment'      }); return; }

        database.ref('game/secondVoteReveal/active').once('value', (svSnap) => {
            if (svSnap.val() === true)       { cb({ mode: 'reveal', voteKey: 'secondVote' }); return; }
            if (phase === 'second-vote')     { cb({ mode: 'vote',   voteKey: 'secondVote' }); return; }
            if (phase === 'first-vote')      { cb({ mode: 'vote',   voteKey: 'firstVote'  }); return; }
            database.ref('game/firstVote/revealed').once('value', (rvSnap) => {
                if (rvSnap.val() === true)   { cb({ mode: 'reveal', voteKey: 'firstVote'  }); return; }
                cb(null);
            });
        });
    });
}

function _showHostSeatActionMenu(seatNumber, mouseX, mouseY) {
    if (!window.currentUser || window.currentUser.role !== 'host') return;
    const nameEl = document.getElementById('name-' + seatNumber);
    const seatName = nameEl ? nameEl.textContent.trim() : '';
    if (!seatName || seatName === 'EMPTY' || seatName === '') return;

    _dismissHostActionMenu();

    _detectHostActionContext((ctx) => {
        if (!ctx) return;

        const menu = document.createElement('div');
        menu.id = 'host-seat-action-menu';
        window._hostSeatActionMenu = menu;

        const px = Math.min(mouseX + 10, window.innerWidth  - 200);
        const py = Math.min(mouseY - 10,  window.innerHeight - 130);

        menu.style.cssText = 'position:fixed;background:rgba(20,20,30,0.97);border:1px solid rgba(255,215,0,0.5);border-radius:8px;padding:10px 14px;z-index:9999;display:flex;flex-direction:column;gap:8px;min-width:175px;box-shadow:0 4px 20px rgba(0,0,0,0.7);left:' + px + 'px;top:' + py + 'px;';

        const header = document.createElement('div');
        header.style.cssText = 'color:#FFD700;font-size:12px;font-weight:bold;margin-bottom:2px';
        header.textContent = 'Seat ' + seatNumber + ' — ' + seatName;
        menu.appendChild(header);

        const actionLabel = ctx.mode === 'vote' ? '\uD83D\uDCCB Assign Vote'
                          : ctx.mode === 'reveal' ? '\uD83D\uDC41 Reveal Vote'
                          : '\uD83C\uDFAD Reveal Role';
        const actionColor = ctx.mode === 'vote'   ? 'linear-gradient(135deg,#1a3a5c,#2a6090)'
                          : ctx.mode === 'reveal' ? 'linear-gradient(135deg,#1a4a1a,#2d7a2d)'
                          :                         'linear-gradient(135deg,#4a1a4a,#7a2d7a)';

        const actionBtn = document.createElement('button');
        actionBtn.textContent = actionLabel;
        actionBtn.style.cssText = 'background:' + actionColor + ';color:white;border:none;padding:9px 12px;border-radius:5px;cursor:pointer;font-size:13px;text-align:left;';
        actionBtn.onclick = () => {
            _dismissHostActionMenu();
            if      (ctx.mode === 'vote')   _hostAssignVote(seatNumber, seatName, ctx.voteKey);
            else if (ctx.mode === 'reveal') _hostRevealVote(seatNumber, seatName, ctx.voteKey);
            else                            _hostRevealRole(seatNumber, seatName, ctx.roleType);
        };
        menu.appendChild(actionBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'background:rgba(255,255,255,0.08);color:#bbb;border:none;padding:7px 12px;border-radius:5px;cursor:pointer;font-size:12px;';
        cancelBtn.onclick = _dismissHostActionMenu;
        menu.appendChild(cancelBtn);

        document.body.appendChild(menu);
        setTimeout(() => {
            const dismiss = (e) => {
                if (!menu.contains(e.target)) { _dismissHostActionMenu(); document.removeEventListener('click', dismiss); }
            };
            document.addEventListener('click', dismiss);
        }, 50);
    });
}

// ASSIGN VOTE
function _hostAssignVote(voterSeat, voterName, voteKey) {
    // Smoke vote: assign 'end' or 'banish', not a player
    if (voteKey === 'smoke') {
        _hostAssignSmokeVote(voterSeat, voterName);
        return;
    }
    database.ref('players').once('value', (pSnap) => {
        const players = pSnap.val() || {};
        const voterEntry = Object.entries(players).find(([k,v]) => v.seat === voterSeat);
        if (!voterEntry) { alert('Could not find player in seat ' + voterSeat); return; }
        const [voterId] = voterEntry;
        const candidates = Object.values(players).filter(p => p.seat && !p.isHost && p.id !== voterId && p.name).sort((a,b) => a.seat - b.seat);

        const existing = document.getElementById('host-assign-vote-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'host-assign-vote-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = '<div style="background:#1a1a2e;border:1px solid rgba(102,126,234,0.5);border-radius:12px;padding:28px 32px;max-width:500px;width:90%;text-align:center;"><h3 style="color:#667eea;margin:0 0 6px;">Assign Vote for ' + voterName + '</h3><p style="color:#bbb;margin:0 0 18px;font-size:0.9rem;">Select who Seat ' + voterSeat + ' is voting for:</p><div id="host-assign-vote-pills" style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:18px;"></div><p id="host-assign-vote-display" style="color:#4CAF50;font-weight:bold;min-height:1.4em;margin-bottom:14px;"></p><div style="display:flex;gap:10px;justify-content:center;"><button id="host-assign-vote-confirm" style="padding:10px 24px;background:#667eea;border:none;border-radius:7px;color:white;font-weight:bold;font-size:1rem;cursor:pointer;" disabled>Assign</button><button id="host-assign-vote-cancel" style="padding:10px 24px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:7px;color:#bbb;cursor:pointer;">Cancel</button></div></div>';
        document.body.appendChild(modal);

        const pillsEl   = document.getElementById('host-assign-vote-pills');
        const displayEl = document.getElementById('host-assign-vote-display');
        const confirmEl = document.getElementById('host-assign-vote-confirm');
        let selectedSeat = null, selectedName = null;

        candidates.forEach(cand => {
            const btn = document.createElement('button');
            btn.textContent = cand.name;
            btn.dataset.seat = cand.seat;
            btn.style.cssText = 'padding:10px 18px;background:rgba(102,126,234,0.15);border:2px solid #667eea;border-radius:50px;color:white;cursor:pointer;font-size:0.95rem;font-weight:bold;';
            btn.onclick = () => {
                selectedSeat = cand.seat; selectedName = cand.name;
                pillsEl.querySelectorAll('button').forEach(b => { b.style.background = b === btn ? 'rgba(102,126,234,0.6)' : 'rgba(102,126,234,0.15)'; b.style.borderColor = b === btn ? '#fff' : '#667eea'; });
                displayEl.textContent = 'Voting for: ' + cand.name;
                confirmEl.disabled = false;
            };
            pillsEl.appendChild(btn);
        });

        confirmEl.onclick = () => { if (!selectedSeat) return; modal.remove(); _hostWriteAssignedVote(voterId, voterSeat, voterName, selectedSeat, selectedName, voteKey); };
        document.getElementById('host-assign-vote-cancel').onclick = () => modal.remove();
    });
}

function _hostAssignSmokeVote(voterSeat, voterName) {
    database.ref('players').once('value', (pSnap) => {
        const players = pSnap.val() || {};
        const voterEntry = Object.entries(players).find(([k,v]) => v.seat === voterSeat);
        if (!voterEntry) { alert('Could not find player in seat ' + voterSeat); return; }
        const [voterId] = voterEntry;

        const existing = document.getElementById('host-assign-vote-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'host-assign-vote-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = '<div style="background:#1a1a2e;border:1px solid rgba(102,126,234,0.5);border-radius:12px;padding:28px 32px;max-width:420px;width:90%;text-align:center;">'
            + '<h3 style="color:#667eea;margin:0 0 8px;">Assign Smoke Vote for ' + voterName + '</h3>'
            + '<p style="color:#bbb;margin:0 0 24px;font-size:0.9rem;">Select their vote:</p>'
            + '<div style="display:flex;gap:16px;justify-content:center;margin-bottom:20px;">'
            + '<button id="smoke-assign-end" style="padding:14px 28px;background:#1a3a6b;border:3px solid #4169E1;border-radius:10px;color:white;cursor:pointer;font-size:1rem;font-weight:bold;">End The Game</button>'
            + '<button id="smoke-assign-banish" style="padding:14px 28px;background:#5a0010;border:3px solid #DC143C;border-radius:10px;color:white;cursor:pointer;font-size:1rem;font-weight:bold;">Banish</button>'
            + '</div>'
            + '<button id="host-assign-vote-cancel" style="padding:8px 20px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:7px;color:#bbb;cursor:pointer;">Cancel</button>'
            + '</div>';
        document.body.appendChild(modal);

        const _writeSmoke = (choice) => {
            modal.remove();
            const updates = {};
            updates['game/endGame/smokeVote/votes/'  + voterId] = choice;
            updates['game/endGame/smokeVote/locked/' + voterId] = true;
            const label = choice === 'end' ? 'End' : 'Banish';
            updates['game/autoVoteDisplay/' + voterId] = { seat: voterSeat, name: label };
            database.ref().update(updates).then(() => {
                showVoteOnNameTag(voterSeat, label, false);
                console.log('Host assigned smoke vote: Seat', voterSeat, '->', choice);
            });
        };
        document.getElementById('smoke-assign-end').onclick    = () => _writeSmoke('end');
        document.getElementById('smoke-assign-banish').onclick = () => _writeSmoke('banish');
        document.getElementById('host-assign-vote-cancel').onclick = () => modal.remove();
    });
}

function _hostWriteAssignedVote(voterId, voterSeat, voterName, targetSeat, targetName, voteKey) {
    const updates = {};
    if (voteKey === 'firstVote') {
        updates['game/firstVote/votes/'         + voterId] = targetSeat;
        updates['game/firstVote/originalVotes/' + voterId] = targetSeat;
        updates['game/firstVote/locked/'        + voterId] = true;
    } else if (voteKey === 'secondVote') {
        updates['game/secondVote/votes/'  + voterId] = targetSeat;
        updates['game/secondVote/locked/' + voterId] = true;
    } else {
        updates['game/endGame/' + voteKey + '/votes/'  + voterId] = targetSeat;
        updates['game/endGame/' + voteKey + '/locked/' + voterId] = true;
    }
    // Push vote display to the voter's own screen.
    // Include the host's name so the player sees who changed their vote.
    const _changedBy = (window.currentUser && window.currentUser.name) || 'Production';
    updates['game/autoVoteDisplay/' + voterId] = {
        seat: voterSeat, name: targetName,
        changedBy: _changedBy  // undefined when player casts own vote
    };
    database.ref().update(updates).then(() => {
        // Also update on host/all-client view
        showVoteOnNameTag(voterSeat, targetName, false);
        console.log('Host assigned vote: Seat', voterSeat, '->', targetName, '(key:', voteKey + ')');
    });
}

// REVEAL VOTE
function _hostRevealVote(seatNumber, seatName, voteKey) {
    database.ref('players').once('value', (pSnap) => {
        const players = pSnap.val() || {};
        const entry = Object.entries(players).find(([k,v]) => v.seat === seatNumber);
        if (!entry) { alert('Could not find player in seat ' + seatNumber); return; }
        const [playerId] = entry;

        const existing = document.getElementById('host-reveal-vote-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'host-reveal-vote-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = '<div style="background:#1a1a2e;border:1px solid rgba(50,205,50,0.4);border-radius:12px;padding:28px 32px;max-width:380px;width:90%;text-align:center;"><h3 style="color:#4CAF50;margin:0 0 8px;">Reveal Vote for ' + seatName + '</h3><p style="color:#bbb;font-size:0.9rem;margin:0 0 22px;">Press “Reveal Vote” when ready.</p><div style="display:flex;gap:10px;justify-content:center;"><button id="host-reveal-vote-confirm" style="padding:11px 26px;background:#4CAF50;border:none;border-radius:7px;color:white;font-weight:bold;font-size:1rem;cursor:pointer;">Reveal Vote</button><button id="host-reveal-vote-cancel" style="padding:11px 26px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:7px;color:#bbb;cursor:pointer;">Cancel</button></div></div>';
        document.body.appendChild(modal);

        document.getElementById('host-reveal-vote-confirm').onclick = () => { modal.remove(); _hostTriggerReveal(playerId, voteKey); };
        document.getElementById('host-reveal-vote-cancel').onclick  = () => modal.remove();
    });
}

function _hostTriggerReveal(playerId, voteKey) {
    // Perform the FULL reveal on behalf of the player — same writes as revealMyVote()
    // so the vote appears in the tally and on all name boxes exactly as normal.
    if (voteKey === 'firstVote') {
        _hostDoRevealWrite(playerId, 'game/firstVote/votes', 'game/revealedVoteDisplay', 'game/firstVote/alreadyRevealed');
    } else if (voteKey === 'secondVote') {
        _hostDoRevealWrite(playerId, 'game/secondVote/votes', 'game/secondVoteReveal/revealedVotes', 'game/secondVoteReveal/alreadyRevealed');
    } else if (voteKey === 'smoke') {
        // Smoke reveal: write to game/endGame/smokeReveal (same as performSmokeReveal)
        database.ref('game/endGame/smokeVote').once('value', (smokeSnap) => {
            const smokeData = smokeSnap.val() || {};
            const voteData  = (smokeData.votes || {})[playerId];
            const choice    = voteData || null;
            const color     = choice === 'end' ? '#4169E1' : '#DC143C';
            database.ref('players/' + playerId).once('value', (pSnap) => {
                const p = pSnap.val() || {};
                database.ref('game/endGame/smokeReveal').set({
                    playerId, playerSeat: p.seat, choice,
                    label:        choice === 'end' ? 'END THE GAME' : 'BANISH',
                    nameBoxLabel: choice === 'end' ? 'End' : 'Banish',
                    color, timestamp: Date.now()
                });
                database.ref('players/' + playerId + '/endGameReadyToRevealSmoke').set(false);
            });
        });
    } else {
        // banishment or banishmentTie — same as performBanishmentReveal()
        database.ref('game/endGame/' + voteKey).once('value', (snap) => {
            const data = snap.val() || {};
            const votedSeat = (data.votes || {})[playerId];
            if (!votedSeat) { alert('No vote found for this player in ' + voteKey); return; }
            database.ref('players').once('value', (pSnap) => {
                const players      = pSnap.val() || {};
                const voterPlayer  = players[playerId];
                const targetPlayer = Object.values(players).find(p => p.seat === parseInt(votedSeat, 10));
                const votedFor     = targetPlayer ? targetPlayer.name : ('Seat ' + votedSeat);
                database.ref('game/endGame/' + voteKey + '/revealedVotes/' + playerId).set({
                    seat: voterPlayer ? voterPlayer.seat : null,
                    name: voterPlayer ? voterPlayer.name : null,
                    votedFor, timestamp: Date.now()
                });
                database.ref('game/endGame/' + voteKey + '/alreadyRevealed/' + playerId).set(true);
                database.ref('players/' + playerId + '/endGameReadyToRevealBanish').set(false);
            });
        });
    }
}

// Shared helper: reads vote from votePath, writes reveal to revealPath
// This exactly mirrors revealMyVote() logic for first/second vote reveal
function _hostDoRevealWrite(playerId, votePath, revealPath, alreadyRevealedPath) {
    database.ref(votePath).once('value', (votesSnap) => {
        const allVotes = votesSnap.val() || {};
        const votedSeat = allVotes[playerId];
        if (!votedSeat) { alert('No vote found for this player.'); return; }
        database.ref('players').once('value', (pSnap) => {
            const players      = pSnap.val() || {};
            const voterPlayer  = players[playerId];
            const targetPlayer = Object.values(players).find(p => p.seat === votedSeat);
            const targetName   = targetPlayer ? targetPlayer.name : ('Seat ' + votedSeat);
            const revealData   = {
                seat:      voterPlayer ? voterPlayer.seat : null,
                name:      voterPlayer ? voterPlayer.name : null,
                votedFor:  targetName,
                timestamp: Date.now()
            };
            database.ref(revealPath + '/' + playerId).set(revealData);
            database.ref(alreadyRevealedPath + '/' + playerId).set(true);
            console.log('Host performed reveal write for player', playerId, '->', targetName);
        });
    });
}

// REVEAL ROLE
function _hostRevealRole(seatNumber, seatName, roleType) {
    database.ref('players').once('value', (pSnap) => {
        const players = pSnap.val() || {};
        const entry = Object.entries(players).find(([k,v]) => v.seat === seatNumber);
        if (!entry) { alert('Could not find player in seat ' + seatNumber); return; }
        const [playerId] = entry;

        const existing = document.getElementById('host-reveal-role-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'host-reveal-role-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = '<div style="background:#1a1a2e;border:1px solid rgba(148,0,211,0.5);border-radius:12px;padding:28px 32px;max-width:380px;width:90%;text-align:center;"><h3 style="color:#da70d6;margin:0 0 8px;">Reveal Role for ' + seatName + '</h3><p style="color:#bbb;font-size:0.9rem;margin:0 0 22px;">Press “Reveal Role” when ready.</p><div style="display:flex;gap:10px;justify-content:center;"><button id="host-reveal-role-confirm" style="padding:11px 26px;background:linear-gradient(135deg,#7a2d9a,#9a3dba);border:none;border-radius:7px;color:white;font-weight:bold;font-size:1rem;cursor:pointer;">Reveal Role</button><button id="host-reveal-role-cancel" style="padding:11px 26px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:7px;color:#bbb;cursor:pointer;">Cancel</button></div></div>';
        document.body.appendChild(modal);

        document.getElementById('host-reveal-role-confirm').onclick = () => {
            modal.remove();
            if (roleType === 'cot') {
                // Read the CoT data and player role, then write game/roleReveal directly
                // so the big reveal text appears for everyone immediately — same as if
                // the player clicked 'Reveal Role' themselves.
                database.ref('game/circleOfTruth').once('value', (cotSnap) => {
                    const cotData = cotSnap.val();
                    database.ref('players/' + playerId + '/role').once('value', (roleSnap) => {
                        const playerRole = roleSnap.val();
                        if (!playerRole) { alert('No role assigned to this player.'); return; }
                        // Write the roleReveal signal — picked up by all clients
                        database.ref('game/roleReveal').set({
                            role: playerRole,
                            playerId: playerId,
                            seatNumber: cotData ? cotData.seatNumber : null,
                            timestamp: Date.now()
                        });
                        // Clear the readyToRevealRole flag
                        database.ref('players/' + playerId + '/readyToRevealRole').set(false);
                        console.log('Host revealed role for CoT player:', playerRole);
                    });
                });
            } else {
                const ref2 = database.ref('players/' + playerId + '/readyToRevealEndGameRole');
                ref2.set(false).then(() => ref2.set(true));
            }
        };
        document.getElementById('host-reveal-role-cancel').onclick = () => modal.remove();
    });
}


function _showSeatSwitchMenu(targetSeat, mouseX, mouseY) {
    // Remove any existing switch menu
    const existing = document.getElementById('seat-switch-menu');
    if (existing) existing.remove();

    const myName = (window.currentUser && window.currentUser.name) || 'You';
    const targetEl = document.getElementById('name-' + targetSeat);
    const targetName = targetEl ? targetEl.textContent : ('Seat ' + targetSeat);

    const menu = document.createElement('div');
    menu.id = 'seat-switch-menu';
    menu.style.cssText = [
        'position:fixed',
        'background:rgba(20,20,30,0.96)',
        'border:1px solid rgba(255,215,0,0.5)',
        'border-radius:8px',
        'padding:10px 14px',
        'z-index:9998',
        'display:flex',
        'flex-direction:column',
        'gap:8px',
        'min-width:160px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
        'left:' + Math.min(mouseX + 10, window.innerWidth - 180) + 'px',
        'top:' + Math.min(mouseY - 10, window.innerHeight - 100) + 'px',
    ].join(';');

    menu.innerHTML = '<div style="color:#FFD700;font-size:12px;font-weight:bold;margin-bottom:4px">Seat ' + targetSeat + ' — ' + targetName + '</div>' +
        '<button id="seat-switch-btn" style="background:linear-gradient(135deg,#1a4a1a,#2d7a2d);color:white;border:none;padding:8px 12px;border-radius:5px;cursor:pointer;font-size:13px;">🔄 Switch Seats</button>' +
        '<button id="seat-switch-cancel" style="background:rgba(255,255,255,0.1);color:#bbb;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:12px;">Cancel</button>';

    document.body.appendChild(menu);

    document.getElementById('seat-switch-btn').onclick = () => {
        menu.remove();
        const mySeat = window.currentUser && window.currentUser.seat;
        // Write switch request to Firebase — target will see it
        database.ref('game/seatSwitch').set({
            from: mySeat,
            to: targetSeat,
            fromName: myName,
            requestedAt: Date.now()
        });
        console.log('🔄 Seat switch requested:', mySeat, '↔', targetSeat);
    };
    document.getElementById('seat-switch-cancel').onclick = () => menu.remove();

    // Auto-dismiss if clicking elsewhere
    const dismiss = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', dismiss, true);
        }
    };
    setTimeout(() => document.addEventListener('click', dismiss, true), 50);
}

// Watch for incoming seat switch requests
function _setupSeatSwitchListener() {
    // Watch for completed display swaps — applies to ALL tabs
    database.ref('game/displaySwap').on('value', (snap) => {
        const sw = snap.val();
        if (!sw) return;
        console.log('🔄 Display swap received:', sw.seatA, '↔', sw.seatB);
        _applyDisplaySwap(sw.seatA, sw.seatB, sw.nameA, sw.nameB, sw.identityA, sw.identityB);
        // Store swap state so _lkIdentityToSeat and name displays can respect it
        window._activeDisplaySwap = {
            seatA: sw.seatA, seatB: sw.seatB,
            nameA: sw.nameA, nameB: sw.nameB,
            pronounsA: sw.pronounsA || '', pronounsB: sw.pronounsB || '',
            identityA: sw.identityA, identityB: sw.identityB
        };
    });

    database.ref('game/seatSwitch').on('value', (snap) => {
        const req = snap.val();
        if (!req) return;

        const myS = window.currentUser && window.currentUser.seat;
        if (!myS) return;

        // Only respond if this request targets me
        if (String(req.to) !== String(myS)) return;

        // Don't show if I was the one who sent it
        if (String(req.from) === String(myS)) return;

        // Show confirmation modal
        const existing = document.getElementById('seat-switch-confirm');
        if (existing) return; // already showing

        const overlay = document.createElement('div');
        overlay.id = 'seat-switch-confirm';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';
        overlay.innerHTML = '<div style="background:rgba(20,20,30,0.98);border:1px solid rgba(255,215,0,0.5);border-radius:12px;padding:28px 32px;text-align:center;max-width:340px;color:white;">' +
            '<h3 style="color:#FFD700;margin-bottom:12px;">🔄 Seat Switch Request</h3>' +
            '<p style="color:#bbb;margin-bottom:20px;line-height:1.5;"><strong style="color:white;">' + req.fromName + '</strong> (Seat ' + req.from + ') wants to switch seats with you.</p>' +
            '<div style="display:flex;gap:12px;justify-content:center;">' +
            '<button id="switch-yes" style="background:linear-gradient(135deg,#1a5c1a,#2d8a2d);color:white;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;">✅ Yes, Switch</button>' +
            '<button id="switch-no" style="background:rgba(255,255,255,0.15);color:white;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;">❌ No Thanks</button>' +
            '</div></div>';

        document.body.appendChild(overlay);

        document.getElementById('switch-yes').onclick = () => {
            overlay.remove();
            _executeSeatSwap(req.from, req.to);
            database.ref('game/seatSwitch').remove();
        };
        document.getElementById('switch-no').onclick = () => {
            overlay.remove();
            database.ref('game/seatSwitch').remove();
        };

        // Auto-dismiss after 30s
        setTimeout(() => {
            if (document.getElementById('seat-switch-confirm')) {
                document.getElementById('seat-switch-confirm').remove();
                database.ref('game/seatSwitch').remove();
            }
        }, 30000);
    });
}

function _executeSeatSwap(seatA, seatB) {
    console.log('🔄 Executing permanent seat swap:', seatA, '↔', seatB);

    database.ref('players').once('value', (snap) => {
        let playerA = null, playerB = null, keyA = null, keyB = null;
        snap.forEach((child) => {
            const p = child.val();
            if (!p) return;
            if (String(p.seat) === String(seatA)) { playerA = p; keyA = child.key; }
            if (String(p.seat) === String(seatB)) { playerB = p; keyB = child.key; }
        });
        if (!playerA || !playerB) {
            console.warn('🔄 Swap: could not find both players', {seatA, seatB, playerA, playerB});
            return;
        }

        // Write displaySwap so all tabs update their DOM and video immediately.
        // We do NOT change seat fields in Firebase — prod seat letters are permanent
        // identity (FIXED_LETTERS=['B','C','D'] in _positionProdSeats), changing them
        // causes prod seats to disappear. The swap is view-layer only.
        database.ref('game/displaySwap').set({
            seatA, seatB,
            nameA: playerA.name || seatA,
            nameB: playerB.name || seatB,
            pronounsA: playerA.pronouns || '',
            pronounsB: playerB.pronouns || '',
            identityA: playerA.name,
            identityB: playerB.name,
            swappedAt: Date.now()
        });
        console.log('🔄 Display swap written — ' + seatA + '↔' + seatB);
    });
}



// Apply a visual seat swap on this page — swaps names, AV buttons, and video feeds
function _applyDisplaySwap(seatA, seatB, nameA, nameB, identityA, identityB) {
    console.log('🔄 Applying visual swap:', seatA, '↔', seatB);

    // Step 1: Swap name and pronouns labels
    const nameElA = document.getElementById('name-' + seatA);
    const nameElB = document.getElementById('name-' + seatB);
    if (nameElA) nameElA.textContent = nameB;
    if (nameElB) nameElB.textContent = nameA;
    const pronElA = document.getElementById('pronouns-' + seatA);
    const pronElB = document.getElementById('pronouns-' + seatB);
    // Firebase will propagate the correct pronouns, but swap DOM immediately too
    if (pronElA && pronElB) {
        const _tmpPron = pronElA.textContent;
        pronElA.textContent = pronElB.textContent;
        pronElB.textContent = _tmpPron;
    }

    // Step 2: Update currentUser.seat so AV buttons target the swapped seat
    // Note: Firebase seat field is NOT changed — only the local view is updated
    const _cu = window.currentUser;
    if (_cu) {
        if (String(_cu.seat) === String(seatA)) {
            _cu.seat = seatB;
            sessionStorage.setItem('playerSeat', String(seatB));
            console.log('🔄 My seat updated locally:', seatA, '→', seatB);
        } else if (String(_cu.seat) === String(seatB)) {
            _cu.seat = seatA;
            sessionStorage.setItem('playerSeat', String(seatA));
            console.log('🔄 My seat updated locally:', seatB, '→', seatA);
        }
    }

    // Step 3 removed: AV buttons stay in their seat containers.
    // setupAVControls(newSeat) is called below and handles show/hide correctly.

    // Step 4: Swap video feeds
    const room = window._lkRoom;
    if (!room) return;

    // Clear existing video from both seat containers
    const _vContA = document.getElementById('video-' + seatA);
    const _vContB = document.getElementById('video-' + seatB);
    if (_vContA) _vContA.querySelectorAll('.lk-video, video').forEach(v => { v.srcObject = null; v.remove(); });
    if (_vContB) _vContB.querySelectorAll('.lk-video, video').forEach(v => { v.srcObject = null; v.remove(); });

    // Re-attach each participant's video to the swapped seat
    const allParticipants = [...(room.remoteParticipants ? room.remoteParticipants.values() : [])];
    if (room.localParticipant) allParticipants.push(room.localParticipant);

    allParticipants.forEach((participant) => {
        const identity = participant.identity;
        const _baseId = identity.includes('~') ? identity.split('~')[0] : identity;
        // Determine which seat this participant should NOW be in
        let newSeat = null;
        if (_baseId === identityA || identity === identityA) newSeat = seatB;
        else if (_baseId === identityB || identity === identityB) newSeat = seatB === seatA ? seatB : seatA;
        if (!newSeat) return;
        // Correct the second case: identityB → seatA
        if (_baseId === identityB || identity === identityB) newSeat = seatA;

        const isLocal = participant === room.localParticipant;
        participant.trackPublications.forEach((pub) => {
            if (pub.kind !== LivekitClient.Track.Kind.Video) return;
            if (!pub.track) return;
            if (!isLocal && !pub.isSubscribed) return;
            setTimeout(() => {
                _lkAttachVideo(pub.track, newSeat, true, 0, isLocal);
                console.log('🔄 Re-attached video for', identity, '→ seat', newSeat);
            }, 200);
        });
    });

    // Reset _avControlsSetup flags on all prod seat elements so setupAVControls
    // fires once for the new seat after the swap
    ['A','B','C','D'].forEach(l => {
        const _sel = document.getElementById('seat-' + l);
        if (_sel) _sel._avControlsSetup = false;
    });

    // Call setupAVControls for this user's new seat so buttons show correctly
    const _cuSwap = window.currentUser;
    if (_cuSwap && _cuSwap.seat && typeof window.setupAVControls === 'function') {
        setTimeout(() => window.setupAVControls(_cuSwap.seat), 300);
    }
}


// ============================================================
// LIVEKIT VIDEO INTEGRATION
// ============================================================
//
// Architecture:
//   - Token fetched from Firebase Cloud Function: /livekitToken?room=X&identity=Y
//   - One LiveKit room per game room: "subversion-main", "subversion-turret", etc.
//   - Each participant's video track is injected into their seat's video-N div
//   - Night / Breakfast phases: disconnect fully (cameras off, zero bandwidth)
//   - Re-entering a room: fetch a new token and reconnect
//
// To understand the flow:
//   joinLiveKitRoom(gameRoom)  →  fetch token  →  connect to LiveKit
//   →  publish own tracks  →  subscribe to others  →  attach video to seats
//
// Firebase Cloud Function URL (set after deploy):
const LIVEKIT_TOKEN_URL = 'https://us-central1-subversion-the-traitors.cloudfunctions.net/livekitToken';
const LIVEKIT_WS_URL    = 'wss://subversion-the-traitors-h0coqxjc.livekit.cloud';

// ── Mobile font size helper ─────────────────────────────────
// Returns appropriate name font size based on screen width.
// Used for inline style assignments that would override CSS media queries.
function _nameFontSize() {
    return window.innerWidth <= 600 ? '0.5rem' : '1.2rem';
}

// ── State ─────────────────────────────────────────────────────
window._lkRoom         = null;   // active LiveKit Room instance
window._lkGameRoom     = null;   // current game room name (e.g. "main")
window._lkLocalTracks  = [];     // own published tracks
window._lkConnecting   = false;  // guard against double-connects

// ── Helpers ───────────────────────────────────────────────────

// Get current user safely (works in both host.html and player.html scope)
function _lkCurrentUser() {
    return window.currentUser || (typeof currentUser !== 'undefined' ? currentUser : null);
}

// Map a LiveKit participant identity to their seat number
// Identity is the player's display name; we look it up in Firebase
async function _lkIdentityToSeat(identity, isMainRoom, attempt) {
    attempt = attempt || 0;

    // Fast path: scan gameState.players cache before hitting Firebase.
    // gameState.players is kept up-to-date by the players.on('value') listener.
    // Strip tab suffix (e.g. 'Hostie~abc123' → 'Hostie') before name matching
    const _baseName = identity.includes('~') ? identity.split('~')[0] : identity;

    // If there's an active display swap, redirect video to the swapped seat
    if (isMainRoom && window._activeDisplaySwap) {
        const _sw = window._activeDisplaySwap;
        if (_baseName === _sw.identityA || _baseName === _sw.nameA) return _sw.seatB;
        if (_baseName === _sw.identityB || _baseName === _sw.nameB) return _sw.seatA;
    }


    if (gameState && gameState.players) {
        let cachedSeat = null;
        for (const pid in gameState.players) {
            const p = gameState.players[pid];
            if (p.name !== _baseName) continue;
            if (isMainRoom) {
                const s = p.seat;
                if (s !== null && s !== undefined) {
                    if (typeof s === 'string' && isNaN(s)) { cachedSeat = s; break; }
                    else if (!cachedSeat) cachedSeat = s;
                }
            } else {
                if (p.roomSeat) { cachedSeat = p.roomSeat; break; }
            }
        }
        if (cachedSeat) return cachedSeat; // resolved without any network call
    }

    return new Promise((resolve) => {
        database.ref('players')
            .orderByChild('name')
            .equalTo(_baseName)  // _baseName already has suffix stripped
            .once('value', (snap) => {
                let seat = null;
                snap.forEach((child) => {
                    const p = child.val();
                    if (isMainRoom) {
                        const s = p.seat;
                        if (s !== null && s !== undefined) {
                            if (typeof s === 'string' && isNaN(s)) {
                                seat = s;
                            } else if (!seat || typeof seat === 'number' || !isNaN(seat)) {
                                seat = s;
                            }
                        }
                    } else {
                        seat = p.roomSeat || null;
                    }
                });
                if (!seat && attempt < 6) {
                    // Seat not assigned yet — retry up to 6 times × 300ms = 1.8s
                    setTimeout(() => {
                        _lkIdentityToSeat(identity, isMainRoom, attempt + 1).then(resolve);
                    }, 300);
                } else {
                    resolve(seat);
                }
            });
    });
}

// Attach a video track to a seat's video-N div
function _lkAttachVideo(track, seatNumber, isMainRoom, attempt, isLocal, identity) {
    attempt = attempt || 0; isLocal = !!isLocal;
    const divId = isMainRoom ? `video-${seatNumber}` : `room-video-${seatNumber}`;
    const container = document.getElementById(divId);
    if (!container) {
        if (!isMainRoom && attempt < 20) {
            // room-video-N not ready yet (overlay not open / seats not generated)
            // retry up to 20 times × 300ms = 6 seconds
            setTimeout(() => {
                // If video was attached by another path during the wait, skip
                const _rc = document.getElementById(divId);
                if (_rc && _rc.querySelector('.lk-video') &&
                    (!identity || _rc.dataset.lkIdentity === identity)) return;
                _lkAttachVideo(track, seatNumber, isMainRoom, attempt + 1, isLocal, identity);
            }, 300);
        } else {
            console.warn('📹 No container found for seat:', seatNumber, divId);
        }
        return;
    }

    // Guard against wrong-identity video attachment.
    // If this seat already has a feed from the SAME identity, skip entirely
    // to avoid the remove→attach cycle that causes flickering.
    const old = container.querySelector('.lk-video');
    if (old && identity) {
        const existingOwner = container.dataset.lkIdentity;
        if (existingOwner === identity) {
            // Same person, same seat — already attached, nothing to do.
            return;
        }
        if (existingOwner && existingOwner !== identity) {
            console.log(`📹 Seat ${seatNumber} already owned by ${existingOwner}, skipping ${identity}`);
            return;
        }
    }
    if (old) { old.srcObject = null; old.remove(); }

    // Create and style the video element
    const videoEl = track.attach();
    videoEl.className = 'lk-video';
    // Mirror ALL video — webcams send naturally mirrored (selfie) view
    // scaleX(-1) corrects this for all participants
    videoEl.style.cssText = [
        'width: 100%',
        'height: 100%',
        'object-fit: cover',
        'border-radius: 50%',
        'position: absolute',
        'top: 0',
        'left: 0',
        'pointer-events: none',
        'transform: scaleX(-1)',
    ].join('; ');

    // Make container relative so video fills it
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    container.style.borderRadius = '50%';

    container.appendChild(videoEl);
    if (identity) container.dataset.lkIdentity = identity; // track who owns this seat
    // Remove disconnect icon for this seat — video is live again
    if (isMainRoom) _hideDisconnectIcon(seatNumber);
    console.log('📹 Attached video to:', divId);
}

// Track which main-room seats are LiveKit-disconnected
// (player record still in Firebase but browser closed / refreshing)
window._lkDisconnectedSeats = window._lkDisconnectedSeats || new Set();

function _showDisconnectIcon(seatNumber, isMainRoom) {
    if (!isMainRoom) return; // only main room seats show the icon
    window._lkDisconnectedSeats.add(seatNumber);
    const seatEl = document.getElementById('seat-' + seatNumber);
    if (!seatEl) return;
    if (seatEl.querySelector('.disconnect-icon')) return; // already showing
    const icon = document.createElement('div');
    icon.className = 'disconnect-icon';
    icon.title = 'Player disconnected';
    icon.style.cssText = [
        'position:absolute',
        'top:50%',
        'left:50%',
        'transform:translate(-50%,-50%)',
        'width:40%',
        'height:40%',
        'border-radius:50%',
        'background:rgba(0,0,0,0.55)',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'z-index:20',
        'pointer-events:none',
    ].join(';');
    // Broken-link / disconnected SVG icon
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:65%;height:65%;opacity:0.9;">'
        + '<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>'
        + '<path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>'
        + '<line x1="2" y1="2" x2="22" y2="22"/>'
        + '</svg>';
    seatEl.appendChild(icon);
    console.log('🔌 Disconnect icon shown for seat', seatNumber);
}

function _hideDisconnectIcon(seatNumber) {
    window._lkDisconnectedSeats.delete(seatNumber);
    const seatEl = document.getElementById('seat-' + seatNumber);
    if (!seatEl) return;
    const icon = seatEl.querySelector('.disconnect-icon');
    if (icon) { icon.remove(); console.log('🔌 Disconnect icon removed for seat', seatNumber); }
}

// Detach all video from a seat
function _lkDetachSeat(seatNumber, isMainRoom) {
    const divId = isMainRoom ? `video-${seatNumber}` : `room-video-${seatNumber}`;
    const container = document.getElementById(divId);
    if (!container) return;
    const old = container.querySelector('.lk-video');
    if (old) {
        old.srcObject = null;
        old.remove();
    }
    // Clear identity marker so the next player can claim this seat
    delete container.dataset.lkIdentity;
}

// ── Core: join a LiveKit room ─────────────────────────────────
// Per-tab LiveKit identity suffix — prevents two tabs with same display name
// from sharing a LiveKit identity and causing duplicate feeds.
if (!window._lkTabSuffix) {
    window._lkTabSuffix = sessionStorage.getItem('_lkTabSuffix');
    if (!window._lkTabSuffix) {
        window._lkTabSuffix = Math.random().toString(36).substr(2, 6);
        sessionStorage.setItem('_lkTabSuffix', window._lkTabSuffix);
    }
}

window.joinLiveKitRoom = async function(gameRoom) {
    // Check user and name FIRST before touching any state flags
    const user = _lkCurrentUser();
    if (!user || !user.name || ['New Host', 'New Player'].includes(user.name)) {
        console.log('📹 Waiting for real name before joining LiveKit:', user && user.name);
        return; // Watcher will re-fire when name updates
    }

    // Don't rejoin if already in the same room and connected
    if (window._lkGameRoom === gameRoom && window._lkRoom &&
        window._lkRoom.state === 'connected') {
        console.log('📹 Already connected to LiveKit room:', gameRoom);
        return;
    }

    // Prevent double-connect race
    if (window._lkConnecting) {
        console.log('📹 Already connecting, skipping');
        return;
    }

    // Build identity first so we can start token fetch immediately
    const _lkIdentity = user.name + '~' + (window._lkTabSuffix || 'x');
    console.log('📹 Joining LiveKit room:', gameRoom, '| identity:', _lkIdentity);

    // Snapshot mute state from the LIVE room BEFORE disconnect.
    // room.disconnect() causes LiveKit SDK to internally mute local tracks,
    // so reading track.isMuted after disconnect gives wrong values.
    // The current publication's isMuted is accurate right now.
    if (window._lkRoom && window._lkRoom.localParticipant) {
        const _snapMicPub = window._lkRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        const _snapCamPub = window._lkRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        window._lkPreSwitchMicMuted = _snapMicPub ? _snapMicPub.isMuted : false;
        window._lkPreSwitchCamMuted = _snapCamPub ? _snapCamPub.isMuted : false;
        console.log('📸 Pre-switch mute snapshot: mic', window._lkPreSwitchMicMuted ? 'muted' : 'live', '| cam', window._lkPreSwitchCamMuted ? 'muted' : 'live');
    } else {
        // No existing room — not a room switch
        window._lkPreSwitchMicMuted = null;
        window._lkPreSwitchCamMuted = null;
    }
    // Breakfast re-join: player was muted during night/breakfast, now returning unmuted.
    // Override the snapshot so join treats this as a fresh (unmuted) first join.
    if (window._breakfastReJoin) {
        window._lkPreSwitchMicMuted = null;
        window._lkPreSwitchCamMuted = null;
        window._breakfastReJoin = false;
        console.log('🍳 Breakfast re-join: snapshot overridden → tracks will be live');
    }

    // 1. Start token fetch and disconnect IN PARALLEL.
    //    Token fetch is a network round-trip (~100-400ms).
    //    Disconnect is also async. Running them together saves that time.
    const tokenUrl = `${LIVEKIT_TOKEN_URL}?room=${encodeURIComponent(gameRoom)}&identity=${encodeURIComponent(_lkIdentity)}`;
    console.log('📹 Fetching token from:', tokenUrl);
    const [, tokenResp] = await Promise.all([
        disconnectLiveKit(),
        fetch(tokenUrl),
    ]);

    window._lkConnecting = true;
    window._lkGameRoom = gameRoom;
    const isMainRoom = (gameRoom === 'main');

    try {
        if (!tokenResp.ok) {
            const errText = await tokenResp.text().catch(() => 'no body');
            throw new Error(`Token fetch failed: ${tokenResp.status} — ${errText}`);
        }
        const data = await tokenResp.json();
        console.log('📹 Token received for room:', data.room);
        const token = data.token;

        // 2. Create Room and set up event listeners BEFORE connecting
        // Determine if this participant is host/prod (higher quality) or player (economy)
        const _lkIsHostOrProd = _lkCurrentUser() &&
            (_lkCurrentUser().role === 'host' || _lkCurrentUser().isProdMember);

        const room = new LivekitClient.Room({
            adaptiveStream:    true,  // auto quality based on network
            dynacast:          true,  // only send video to subscribers who need it
            // Economy video for regular players — host/prod get higher quality
            videoCaptureDefaults: {
                // All participants capture at 360p — matches encode target cleanly
                resolution: LivekitClient.VideoPresets.h360.resolution,
            },
            videoPublishDefaults: {
                videoEncoding: _lkIsHostOrProd
                    ? { maxBitrate: 800_000, maxFramerate: 30 }  // host/prod: natural quality
                    : { maxBitrate: 600_000, maxFramerate: 30 }, // players: natural, smooth
                simulcast: false,
            }
        });

        window._lkRoom = room;

        // ── Audio level bars ───────────────────────────────────
        // ActiveSpeakersChanged fires whenever speaking participants change.
        // Each speaker has a .audioLevel (0-1). We scale the bar height by that level.
        // Seats not in the speakers array get their bars collapsed to zero.
        // ── Audio ring — Web Audio API AnalyserNode approach ──────────
        // Uses the actual PCM waveform data from each participant's MediaStream
        // for true real-time amplitude. This responds to every syllable and
        // cadence change, unlike LiveKit's smoothed audioLevel property.
        //
        // Flow per remote participant:
        //   track.mediaStream → AudioContext.createMediaStreamSource()
        //                     → AnalyserNode (fftSize 256, no smoothing)
        //   rAF: getByteTimeDomainData() → RMS amplitude → ring scale
        //
        // For local participant we tap the mic MediaStreamTrack directly.

        // Shared AudioContext — one per room, reused across all participants
        window._ringAudioCtx = window._ringAudioCtx || null;
        function _getRingAudioCtx() {
            if (!window._ringAudioCtx || window._ringAudioCtx.state === 'closed') {
                window._ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (window._ringAudioCtx.state === 'suspended') {
                window._ringAudioCtx.resume().catch(() => {});
            }
            return window._ringAudioCtx;
        }

        // identity → { analyser, dataArray } for remote participants
        // seat     → { analyser, dataArray } for local participant
        const _ringAnalysers = {}; // keyed by identity string
        let   _localRingAnalyser = null;

        // Attach an AnalyserNode to a MediaStream and store under the given key.
        // A bandpass filter (200Hz–3500Hz) isolates human voice frequencies,
        // rejecting desk thumps (<200Hz) and high-frequency noise (>3500Hz).
        function _attachRingAnalyser(key, mediaStream) {
            try {
                const ctx    = _getRingAudioCtx();
                const source = ctx.createMediaStreamSource(mediaStream);

                // Highpass at 200Hz — cuts desk bumps, keyboard thuds, AC rumble
                const _hp = ctx.createBiquadFilter();
                _hp.type            = 'highpass';
                _hp.frequency.value = 200;
                _hp.Q.value         = 0.7;

                // Lowpass at 3500Hz — cuts paper rustling, high-freq noise
                const _lp = ctx.createBiquadFilter();
                _lp.type            = 'lowpass';
                _lp.frequency.value = 3500;
                _lp.Q.value         = 0.7;

                const analyser = ctx.createAnalyser();
                analyser.fftSize             = 256;
                analyser.smoothingTimeConstant = 0; // raw, unsmoothed — we smooth in JS

                // Chain: source → highpass → lowpass → analyser
                source.connect(_hp);
                _hp.connect(_lp);
                _lp.connect(analyser);
                // Do NOT connect to destination — analysis only, no playback

                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                _ringAnalysers[key] = { analyser, dataArray };
            } catch(e) {
                console.warn('🔊 Ring analyser attach failed:', key, e);
            }
        }

        // Compute RMS amplitude (0-1) from a Uint8Array of time-domain samples
        // Samples are 0-255 centred at 128 (silence = all 128s)
        function _computeRMS(dataArray) {
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const v = (dataArray[i] - 128) / 128; // normalise to -1…+1
                sum += v * v;
            }
            return Math.sqrt(sum / dataArray.length);
        }

        // rAF loop state
        const _ringSmooth = {}; // seat → exponentially smoothed amplitude
        let   _ringRafId  = null;
        const _RING_SEATS = ['A','B','C','D'];
        for (let _ri = 1; _ri <= 24; _ri++) _RING_SEATS.push(_ri);

        // identity → seat cache (populated lazily from gameState)
        const _identityToSeatCache = {};

        function _ringTick() {
            _ringRafId = requestAnimationFrame(_ringTick);

            // Populate identity→seat cache from gameState
            room.remoteParticipants.forEach((p) => {
                // Always re-check seat mapping — gameState may not have been ready earlier
                const _base = p.identity.includes('~') ? p.identity.split('~')[0] : p.identity;
                if (_identityToSeatCache[p.identity] == null && gameState && gameState.players) {
                    for (const pid in gameState.players) {
                        const _pp = gameState.players[pid];
                        if (_pp && _pp.name === _base) {
                            _identityToSeatCache[p.identity] = isMainRoom ? _pp.seat : _pp.roomSeat;
                            break;
                        }
                    }
                }

                // Attach analyser if not yet attached — try mediaStreamTrack (LiveKit API)
                if (!_ringAnalysers[p.identity]) {
                    p.trackPublications.forEach((pub) => {
                        if (pub.kind === LivekitClient.Track.Kind.Audio && pub.track) {
                            const _mst = pub.track.mediaStreamTrack || (pub.track.mediaStream && pub.track.mediaStream.getAudioTracks()[0]);
                            if (_mst) {
                                _attachRingAnalyser(p.identity, new MediaStream([_mst]));
                            }
                        }
                    });
                }
            });

            // Local participant: attach analyser once
            if (!_localRingAnalyser && room.localParticipant) {
                room.localParticipant.trackPublications.forEach((pub) => {
                    if (pub.kind === LivekitClient.Track.Kind.Audio && pub.track && pub.track.mediaStream) {
                        try {
                            const _mstLocal = pub.track.mediaStreamTrack || (pub.track.mediaStream && pub.track.mediaStream.getAudioTracks()[0]);
                            if (!_mstLocal) return;
                            const ctx      = _getRingAudioCtx();
                            const source   = ctx.createMediaStreamSource(new MediaStream([_mstLocal]));
                            const _lhp = ctx.createBiquadFilter();
                            _lhp.type = 'highpass'; _lhp.frequency.value = 200; _lhp.Q.value = 0.7;
                            const _llp = ctx.createBiquadFilter();
                            _llp.type = 'lowpass';  _llp.frequency.value = 3500; _llp.Q.value = 0.7;
                            const analyser = ctx.createAnalyser();
                            analyser.fftSize             = 256;
                            analyser.smoothingTimeConstant = 0;
                            source.connect(_lhp); _lhp.connect(_llp); _llp.connect(analyser);
                            const dataArray = new Uint8Array(analyser.frequencyBinCount);
                            _localRingAnalyser = { analyser, dataArray };
                        } catch(e) { /* ignore */ }
                    }
                });
            }

            const _localSeat = window.currentUser && (isMainRoom ? window.currentUser.seat : window.currentUser.roomSeat);

            // Per-seat amplitude → ring scale
            for (const _bs of _RING_SEATS) {
                let _rawRMS = 0;

                // Check remote participants
                room.remoteParticipants.forEach((p) => {
                    if (String(_identityToSeatCache[p.identity]) === String(_bs)) {
                        const _an = _ringAnalysers[p.identity];
                        if (_an) {
                            _an.analyser.getByteTimeDomainData(_an.dataArray);
                            _rawRMS = Math.max(_rawRMS, _computeRMS(_an.dataArray));
                        }
                    }
                });

                // Check local participant
                if (String(_localSeat) === String(_bs) && _localRingAnalyser) {
                    _localRingAnalyser.analyser.getByteTimeDomainData(_localRingAnalyser.dataArray);
                    _rawRMS = Math.max(_rawRMS, _computeRMS(_localRingAnalyser.dataArray));
                }

                // Noise floor: ignore filtered RMS below threshold.
                // Cuts residual breath noise, background hiss, faint bumps.
                const _FLOOR = 0.012;
                if (_rawRMS < _FLOOR) _rawRMS = 0;

                // Asymmetric smoothing: fast attack (0.55), slow decay (0.12)
                const _prev  = _ringSmooth[_bs] || 0;
                const _alpha = _rawRMS > _prev ? 0.55 : 0.12;
                _ringSmooth[_bs] = _prev + (_rawRMS - _prev) * _alpha;

                // Map to visual scale and opacity
                // RMS from speech is typically 0.01-0.15; amplify to fill 0-1 range
                const _amplified = Math.min(1, _ringSmooth[_bs] * 12);
                const _scale     = 1 + _amplified * 0.4;   // 1.0 → 1.4 (reduced from 1.7)
                const _opacity   = _amplified * 0.9;

                const _ring = document.getElementById('aring-' + _bs);
                if (_ring) {
                    _ring.style.transform = `translate(-50%, -50%) scale(${_scale.toFixed(3)})`;
                    _ring.style.opacity   = _opacity.toFixed(3);
                }
            }
        }
        _ringTick();

        // Cancel loop and clean up analysers on disconnect
        room.on(LivekitClient.RoomEvent.Disconnected, () => {
            if (_ringRafId) { cancelAnimationFrame(_ringRafId); _ringRafId = null; }
            Object.values(_ringAnalysers).forEach(a => { try { a.analyser.disconnect(); } catch(e){} });
            Object.keys(_ringAnalysers).forEach(k => delete _ringAnalysers[k]);
            _localRingAnalyser = null;
        });

        // ── Remote participant joined ──────────────────────────
        room.on(LivekitClient.RoomEvent.ParticipantConnected, async (participant) => {
            console.log('📹 Participant connected:', participant.identity);
            const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
            if (!seat) return;
            // Remove disconnect icon — this participant is back
            _hideDisconnectIcon(seat);

            // Subscribe to their tracks
            participant.on(LivekitClient.ParticipantEvent.TrackSubscribed, (track) => {
                if (track.kind === LivekitClient.Track.Kind.Audio) {
                    const audioEl = track.attach();
                    audioEl.style.display = 'none';
                    audioEl.setAttribute('data-lk', '1');
                    document.body.appendChild(audioEl);
                    console.log('🔊 Audio attached for:', participant.identity);
                    return;
                }
                if (track.kind === LivekitClient.Track.Kind.Video) {
                    _lkAttachVideo(track, seat, isMainRoom, 0, false, participant.identity);
                }
            });

            // Handle tracks already published before we subscribed
            participant.trackPublications.forEach((pub) => {
                if (pub.track && pub.kind === LivekitClient.Track.Kind.Video) {
                    _lkAttachVideo(pub.track, seat, isMainRoom, 0, false, participant.identity);
                }
            });
        });

        // ── Remote participant left ────────────────────────────
        room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            console.log('📹 Participant disconnected:', participant.identity);
            // Sync-only lookup — no retries, same reason as TrackUnsubscribed
            const _baseName = participant.identity.includes('~')
                ? participant.identity.split('~')[0] : participant.identity;
            let seat = null;
            let _playerData = null;
            if (gameState && gameState.players) {
                for (const pid in gameState.players) {
                    const p = gameState.players[pid];
                    if (p.name !== _baseName) continue;
                    seat = isMainRoom ? p.seat : p.roomSeat;
                    _playerData = p;
                    if (seat) break;
                }
            }
            // Respect active display swap — video is in the swapped seat, not Firebase seat
            if (seat && isMainRoom && window._activeDisplaySwap) {
                const _swD = window._activeDisplaySwap;
                if (String(seat) === String(_swD.seatA) &&
                    (_baseName === _swD.identityA || _baseName === _swD.nameA)) {
                    seat = _swD.seatB;
                } else if (String(seat) === String(_swD.seatB) &&
                    (_baseName === _swD.identityB || _baseName === _swD.nameB)) {
                    seat = _swD.seatA;
                }
            }
            if (seat) {
                _lkDetachSeat(seat, isMainRoom);
                // Check Firebase after a short delay to let room change propagate.
                // If the player moved to a breakout room, their Firebase room field
                // may not have updated yet when ParticipantDisconnected fires.
                const _disconnSeat = seat;
                const _disconnBaseName = _baseName;
                const _checkBreakout = (delay, showIfNot) => {
                    setTimeout(() => {
                        database.ref('players').once('value', (_dSnap) => {
                            let _inBreakout = false;
                            let _playerRef = null;
                            _dSnap.forEach((_dc) => {
                                const _dp = _dc.val();
                                if (!_dp || _dp.name !== _disconnBaseName) return;
                                _playerRef = _dc.key;
                                const _room = _dp.room || '';
                                if (_room !== 'main' && _room !== 'waiting' && _room !== '') {
                                    _inBreakout = true;
                                }
                            });
                            if (_inBreakout) {
                                console.log('📹 Skip disconnect icon —', _disconnBaseName, 'in breakout');
                                _hideDisconnectIcon(_disconnSeat);
                            } else if (showIfNot) {
                                _showDisconnectIcon(_disconnSeat, isMainRoom);
                            }
                        });
                    }, delay);
                };
                // Wait 3s before showing the icon — if the player moved to a breakout room,
                // their Firebase room field will have updated by then and we skip the icon.
                // This prevents the icon flashing briefly whenever anyone changes rooms.
                _checkBreakout(3000, true); // only show icon if STILL not in breakout after 3s
            }
        });

        // ── Track subscribed (covers participants already in room) ──
        room.on(LivekitClient.RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
            if (track.kind === LivekitClient.Track.Kind.Audio) {
                // Attach audio — creates an <audio> element and plays it
                const audioEl = track.attach();
                audioEl.style.display = 'none';
                document.body.appendChild(audioEl);
                console.log('🔊 Audio attached for:', participant.identity);
                return;
            }
            if (track.kind !== LivekitClient.Track.Kind.Video) return;
            const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
            if (seat) _lkAttachVideo(track, seat, isMainRoom, 0, false, participant.identity);
        });

        // ── Track unsubscribed ─────────────────────────────────
        // IMPORTANT: Do NOT retry here. Retrying for a departing player risks
        // resolving their NEW seat in a NEW room after they've left, then
        // incorrectly clearing another player's video in that new room.
        // We only detach if we can resolve the seat synchronously right now.
        room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
            const _baseName = participant.identity.includes('~')
                ? participant.identity.split('~')[0] : participant.identity;
            let seat = null;
            if (gameState && gameState.players) {
                for (const pid in gameState.players) {
                    const p = gameState.players[pid];
                    if (p.name !== _baseName) continue;
                    seat = isMainRoom ? p.seat : p.roomSeat;
                    if (seat) break;
                }
            }
            // Only detach if resolved — no retries for departing players
            if (seat) _lkDetachSeat(seat, isMainRoom);
        });

        // ── Participant (re)connected — catch any tracks already subscribed ──
        room.on(LivekitClient.RoomEvent.ParticipantConnected, async (participant) => {
            console.log('📹 Participant connected:', participant.identity);
            const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
            if (!seat) return;
            participant.trackPublications.forEach((pub) => {
                if (pub.kind === LivekitClient.Track.Kind.Audio && pub.track && pub.isSubscribed) {
                    const audioEl = pub.track.attach();
                    audioEl.style.display = 'none';
                    audioEl.setAttribute('data-lk', '1');
                    document.body.appendChild(audioEl);
                    console.log('🔊 Audio attached for:', participant.identity);
                }
                if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                    const divId = isMainRoom ? ('video-' + seat) : ('room-video-' + seat);
                    const container = document.getElementById(divId);
                    if (!container || container.querySelector('.lk-video')) return;
                    _lkAttachVideo(pub.track, seat, isMainRoom, 0, false, participant.identity);
                }
            });
        });

        // ── Disconnected (network drop, etc.) ─────────────────
        room.on(LivekitClient.RoomEvent.Disconnected, () => {
            console.log('📹 LiveKit room disconnected');
            window._lkRoom = null;
            window._lkGameRoom = null;
            window._lkConnecting = false;
            // Note: LiveKit has its own built-in reconnect for transient drops.
            // We do NOT auto-rejoin here — that caused infinite reconnect loops
            // when two tabs had the same identity and kept kicking each other.
        });

        // 3. Connect to LiveKit
        await room.connect(LIVEKIT_WS_URL, token);
        console.log('✅ LiveKit connected:', room.name);

        // Ensure AV controls are active after LiveKit connects
        const _user = _lkCurrentUser();
        if (_user && _user.seat && typeof window.setupAVControls === 'function') {
            window.setupAVControls(_user.seat);
        }
        // Sync mobile AV bar to actual track state after connect
        setTimeout(() => {
            const _micPubCheck = room.localParticipant &&
                room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
            const _camPubCheck = room.localParticipant &&
                room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
            const _micMuted = _micPubCheck ? _micPubCheck.isMuted : false;
            const _camMuted = _camPubCheck ? _camPubCheck.isMuted : false;
            const _mobMicSync = document.getElementById('mobile-mic-btn');
            const _mobCamSync = document.getElementById('mobile-cam-btn');
            if (_mobMicSync) {
                _mobMicSync.style.background = _micMuted ? 'rgba(180,30,30,0.9)' : 'rgba(40,40,40,0.9)';
                _mobMicSync.style.borderColor = _micMuted ? 'rgba(255,80,80,0.8)' : 'rgba(255,255,255,0.5)';
            }
            if (_mobCamSync) {
                _mobCamSync.style.background = _camMuted ? 'rgba(180,30,30,0.9)' : 'rgba(40,40,40,0.9)';
                _mobCamSync.style.borderColor = _camMuted ? 'rgba(255,80,80,0.8)' : 'rgba(255,255,255,0.5)';
            }
        }, 800); // after tracks are published and mute state is stable

        // ── Unlock AudioContext (browser autoplay policy) ──────────────
        // Browsers block audio until a user gesture. room.startAudio() resumes it.
        const _tryStartAudio = () => {
            room.startAudio().then(() => {
                console.log('🔊 AudioContext started OK');
            }).catch(() => {
                console.warn('🔊 AudioContext blocked — will unlock on next interaction');
                const _unlock = () => {
                    room.startAudio()
                        .then(() => console.log('🔊 AudioContext unlocked via gesture'))
                        .catch(e => console.warn('🔊 Audio unlock error:', e));
                    document.removeEventListener('click',   _unlock);
                    document.removeEventListener('keydown', _unlock);
                };
                document.addEventListener('click',   _unlock, { once: true });
                document.addEventListener('keydown', _unlock, { once: true });
            });
        };
        _tryStartAudio();

        // 4. Publish own camera + mic
        // Always create fresh tracks — reusing tracks across rooms doesn't work
        // because room.disconnect() internally stops the MediaStreamTrack,
        // making it unrecoverable (readyState='ended').
        // SVTr3Prod observers are audio-only — no video track, ever.
        const _isObserverUser = user && (user.isObserver || user.role === 'observer');
        const tracks = await LivekitClient.createLocalTracks(
            _isObserverUser
                ? { audio: true }  // observer: mic only, no camera
                : {
                    audio: true,
                    video: {
                        resolution: LivekitClient.VideoPresets.h360.resolution,
                        facingMode: 'user',
                    },
                }
        );
        window._lkLocalTracks = tracks;
        console.log('📹 Created', tracks.length, 'local tracks');

        // Pre-mute at the MediaStreamTrack (hardware) level BEFORE publishing.
        // This prevents any audio/video from reaching the new room during the
        // publish handshake (~200-500ms) for players who were muted.
        // The snapshot was taken from the live room BEFORE disconnect, so it's accurate.
        const _preMuteMic = window._lkPreSwitchMicMuted === true;
        const _preMuteCam = window._lkPreSwitchCamMuted === true;
        if (_preMuteMic || _preMuteCam) {
            for (const _t of tracks) {
                if (_preMuteMic && _t.kind === LivekitClient.Track.Kind.Audio) {
                    _t.mute(); // disables MediaStreamTrack.enabled — hardware silence
                }
                if (_preMuteCam && _t.kind === LivekitClient.Track.Kind.Video) {
                    _t.mute(); // disables MediaStreamTrack.enabled — black frame
                }
            }
            console.log('🔇 Pre-muted tracks before publish: mic', _preMuteMic, '| cam', _preMuteCam);
        }

        // LiveKit JS SDK uses publishTrack (singular) per track
        for (const track of tracks) {
            await room.localParticipant.publishTrack(track);
        }
        console.log('✅ Local tracks published:', tracks.length, 'tracks');

        // ── Apply host force-mute/camera-off state immediately after publishing ──
        // Re-read Firebase state in case Mute All / Cameras Off was active before join.
        if (currentUser.role === 'player') {
            database.ref('game/muteAllPlayers').once('value', (muteSnap) => {
                if (muteSnap.val()) {
                    const _mp = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                    if (_mp && !_mp.isMuted) _mp.mute();
                    database.ref('players/' + currentUser.id + '/audioMuted').set(true);
                    console.log('🔇 Force-muted on join (muteAll was active)');
                }
            });
            database.ref('game/camerasOffPlayers').once('value', (camSnap) => {
                if (camSnap.val()) {
                    const _cp = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                    if (_cp && !_cp.isMuted) _cp.mute();
                    database.ref('players/' + currentUser.id + '/videoMuted').set(true);
                    console.log('🔇 Force-disabled camera on join (camerasOff was active)');
                }
            });
        }

        // ── Apply correct mute state after publishing ─────────────────
        const _hasSeat = window.currentUser && (window.currentUser.seat || window.currentUser.roomSeat);
        const _isHostOrProd = window.currentUser && (window.currentUser.role === 'host' || window.currentUser.isProdMember);

        // Use pre-switch snapshot if this is a room switch (set before disconnect).
        // On first join, snapshot is null — fall through to seat-based mute guard.
        const _isRoomSwitch = window._lkPreSwitchMicMuted !== null;
        if (_isRoomSwitch) {
            const _micPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
            const _camPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
            console.log('🎤 Restoring mute state: mic', window._lkPreSwitchMicMuted ? 'muted' : 'live', '| cam', window._lkPreSwitchCamMuted ? 'muted' : 'live');
            if (_micPub) { if (window._lkPreSwitchMicMuted) _micPub.mute(); else _micPub.unmute(); }
            if (_camPub) { if (window._lkPreSwitchCamMuted) _camPub.mute(); else _camPub.unmute(); }
            // Clear snapshot so next join is treated as first-join
            window._lkPreSwitchMicMuted = null;
            window._lkPreSwitchCamMuted = null;
        } else {
            // First join: mute mic if no seat yet.
            // This applies to players, unseated prod members, and prod observers.
            // The main host (seat A) is always exempt — they are never force-muted here.
            const _isMainHost = window.currentUser && window.currentUser.seat === 'A';
            if (!_hasSeat && !_isMainHost) {
                const _micPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                const _camPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                if (_micPub) { _micPub.mute(); }
                if (_camPub) { _camPub.mute(); }
                // Write muted state so icons reflect reality
                if (window.currentUser && window.currentUser.id) {
                    database.ref('players/' + window.currentUser.id + '/audioMuted').set(true);
                }
                console.log('🔇 Tracks muted until seat is claimed (no seat yet)');
            }
        }

        // 7. Watch for participants claiming seats AFTER we're already connected
        // This fires when a remote player's seat field is written to Firebase
        // (they were already in LiveKit but had no seat when step 6 ran)
        if (window._lkSeatWatcher) {
            database.ref('players').off('value', window._lkSeatWatcher);
        }
        // Debounce the seat watcher — rapid Firebase fires are batched into one scan
        let _seatWatcherTimer = null;
        // Reusable scan function — attaches video for any remote participant
        // whose container now exists but hasn't had video attached yet.
        async function _scanAndAttachRoomVideo() {
            room.remoteParticipants.forEach(async (participant) => {
                const seat = await _lkIdentityToSeat(participant.identity, isMainRoom, 0);
                if (!seat) return;
                const divId = isMainRoom ? ('video-' + seat) : ('room-video-' + seat);
                const container = document.getElementById(divId);
                if (!container || container.querySelector('.lk-video')) return;
                participant.trackPublications.forEach((pub) => {
                    if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                        _lkAttachVideo(pub.track, seat, isMainRoom, 0, false, participant.identity);
                        console.log('📹 Scan attached video for', participant.identity, '→', divId);
                    }
                });
            });
        }

        window._lkSeatWatcher = database.ref('players').on('value', () => {
            if (_seatWatcherTimer) return; // already queued
            _seatWatcherTimer = setTimeout(() => {
                _seatWatcherTimer = null;
                _scanAndAttachRoomVideo();
            }, 200);
        });

        // Extra scan after 1.5s for breakout rooms where overlay DOM renders late
        setTimeout(_scanAndAttachRoomVideo, 1500);
        setTimeout(_scanAndAttachRoomVideo, 3000); // second pass for slow connections

        // For breakout rooms: scan already-connected participants and attach video
        // (they may have connected before us so their TrackSubscribed already fired)
        // Late-attach for BOTH main room and breakout — catches already-connected
        // participants whose TrackSubscribed fired before our seat was known
        setTimeout(() => {
            room.remoteParticipants.forEach(async (participant) => {
                const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
                if (!seat) return;
                const divId = isMainRoom ? ('video-' + seat) : ('room-video-' + seat);
                const container = document.getElementById(divId);
                // Only attach if container exists and video not already there
                if (!container || container.querySelector('.lk-video')) return;
                participant.trackPublications.forEach((pub) => {
                    if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                        _lkAttachVideo(pub.track, seat, isMainRoom, 0, false, participant.identity);
                        console.log('📹 Late-attach video:', participant.identity, '→', divId);
                    }
                });
            });
        }, 150);

        // Restore mute state from Firebase on first join only.
        // Room switches use the pre-switch snapshot instead (applied above).
        // Observers manage their own mute via the floating mic button — skip them.
        if (user.id && !_isRoomSwitch) {
            database.ref('players/' + user.id).once('value', (snap) => {
                const pData = snap.val() || {};
                // Don't auto-mute observers from Firebase — their mic state is
                // managed explicitly by the floating mic button on host.html.
                const _skipMuteRestore = pData.isObserver || pData.isProdMember;
                if (pData.audioMuted && !_skipMuteRestore) {
                    if (typeof window._applyMutedState === 'function') {
                        window._applyMutedState(true);
                    } else {
                        const micPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                        if (micPub && !micPub.isMuted) { micPub.mute(); }
                    }
                    console.log('🎤 Restored muted state from Firebase (first join)');
                }
                if (pData.videoMuted) {
                    const camPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                    if (camPub && !camPub.isMuted) {
                        camPub.mute();
                        console.log('📹 Restored video-off state from Firebase (first join)');
                    }
                }
                // Breakfast phase: player just accepted invitation — force-unmute.
                // nightMuted was true during waiting; breakfast accept set it null.
                // Multiple async paths (nightMuted listener, pre-mute guard) could
                // leave tracks muted despite Firebase showing audioMuted=false.
                // This is the authoritative unmute for breakfast re-entry.
                const _phaseNow = window._currentPhase || sessionStorage.getItem('currentPhase') || '';
                if (_phaseNow === 'breakfast' && !pData.nightMuted && !pData.audioMuted) {
                    const _micP = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                    const _camP = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                    if (_micP && _micP.isMuted) { _micP.unmute(); console.log('🍳 Breakfast join: force-unmuted mic'); }
                    if (_camP && _camP.isMuted) { _camP.unmute(); console.log('🍳 Breakfast join: force-unmuted cam'); }
                }
            });
        } else {
            console.log('🎤 Room switch: mute state restored from pre-switch snapshot, skipping Firebase');
        }

        // 5. Attach own video to own seat
        // For non-main rooms roomSeat may not be assigned yet — retry until it is
        // Generation counter — incremented on each joinLiveKitRoom call.
        // _attachOwnVideo checks its captured generation before retrying;
        // if another join has started, the old loop stops silently.
        if (!window._lkAttachGeneration) window._lkAttachGeneration = 0;
        window._lkAttachGeneration++;
        const _myGeneration = window._lkAttachGeneration;

        const _attachOwnVideo = (attempt) => {
            // Stop retrying if a newer joinLiveKitRoom call has started
            if (window._lkAttachGeneration !== _myGeneration) return;
            attempt = attempt || 0;
            const u      = _lkCurrentUser();
            const mySeat = isMainRoom
                ? (u && u.seat)
                : (u && u.roomSeat);  // roomSeat only — main seat ≠ room seat
            console.log('🪑 _attachOwnVideo attempt — isMainRoom:', isMainRoom, '| seat:', u && u.seat, '| roomSeat:', u && u.roomSeat, '| mySeat:', mySeat);

            if (!mySeat) {
                // Observers and unseated prod members never get a seat — skip immediately.
                if (u && (u.isObserver || (u.isProdMember && !u.seat))) {
                    console.log('🪑 Unseated observer/prod — no seat to attach video to, skipping');
                    return;
                }
                // Also check Firebase directly in case currentUser.roomSeat not updated yet
                if (!isMainRoom && u && u.id) {
                    // Host/prod members don't get roomSeat assigned — skip gracefully
                    if (u.role === 'host' || u.id === 'host' || (u.id && u.id.startsWith('prod-'))) {
                        console.log('🪑 Host/prod in breakout room — no roomSeat assigned, skipping own video attach');
                        return;
                    }
                    database.ref('players/' + u.id + '/roomSeat').once('value', (s) => {
                        const dbRoomSeat = s.val();
                        if (dbRoomSeat) {
                            u.roomSeat = dbRoomSeat;
                            if (window.currentUser) window.currentUser.roomSeat = dbRoomSeat;
                            console.log('🪑 Got roomSeat from Firebase:', dbRoomSeat);
                            _attachOwnVideo();
                        } else {
                            setTimeout(() => {
                                if (window._lkAttachGeneration === _myGeneration) _attachOwnVideo();
                            }, 100);
                        }
                    });
                } else {
                    if (attempt < 80) { // max 40s wait
                        setTimeout(() => {
                            if (window._lkAttachGeneration === _myGeneration) _attachOwnVideo(attempt + 1);
                        }, 100);
                    } else {
                        console.log('🪑 _attachOwnVideo: gave up waiting for seat after 40s');
                    }
                }
                return;
            }

            tracks.forEach((track) => {
                if (track.kind === LivekitClient.Track.Kind.Video) {
                    _lkAttachVideo(track, mySeat, isMainRoom, 0, true); // isLocal=true
                }
            });
        };
        _attachOwnVideo();

        // 6. Handle already-connected participants
        room.remoteParticipants.forEach(async (participant) => {
            const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
            if (!seat) return;
            participant.trackPublications.forEach((pub) => {
                if (pub.kind === LivekitClient.Track.Kind.Audio) {
                    if (pub.track && pub.isSubscribed) {
                        const audioEl = pub.track.attach();
                        audioEl.style.display = 'none';
                        audioEl.setAttribute('data-lk', '1');
                        document.body.appendChild(audioEl);
                        console.log('🔊 Audio attached (already connected):', participant.identity);
                    }
                    // else will arrive via TrackSubscribed
                    return;
                }
                if (pub.kind === LivekitClient.Track.Kind.Video) {
                    if (pub.track && pub.isSubscribed) {
                        // Already subscribed — attach immediately
                        _lkAttachVideo(pub.track, seat, isMainRoom);
                    } else {
                        // Not yet subscribed — will arrive via TrackSubscribed event
                        console.log('📹 Waiting for subscription:', participant.identity);
                    }
                }
            });
        });

    } catch (err) {
        console.error('❌ LiveKit connection failed:', err.message || err);
        console.error('❌ Stack:', err.stack || 'no stack');
        window._lkRoom = null;
        window._lkGameRoom = null;
    } finally {
        window._lkConnecting = false;
    }
};

// ── Core: fully disconnect ────────────────────────────────────
window.disconnectLiveKit = async function() {
    if (window._lkLocalTracks.length) {
        window._lkLocalTracks.forEach((track) => track.stop());
        window._lkLocalTracks = [];
    }
    // Remove any injected audio elements
    document.querySelectorAll('audio[data-lk]').forEach(el => el.remove());
    // Clean up the seat watcher
    if (window._lkSeatWatcher) {
        database.ref('players').off('value', window._lkSeatWatcher);
        window._lkSeatWatcher = null;
    }
    // Set _lkGameRoom null BEFORE disconnect so auto-rejoin doesn't fire
    window._lkGameRoom  = null;
    window._lkConnecting = false;
    if (window._lkRoom) {
        try {
            await window._lkRoom.disconnect();
        } catch (e) {
            // Already disconnected — ignore
        }
        window._lkRoom = null;
    }
    console.log('📹 LiveKit disconnected');
};

// ── Phase hooks ───────────────────────────────────────────────

// Called by PhaseManager when entering Night phase
window.enterNightPhase = function() {
    console.log('🌙 Entering Night — disconnecting players from LiveKit');
    // Players must be fully disconnected during night — they cannot hear or see anyone.
    // The room watcher will handle re-connection when phase changes back.
    const _cu = window.currentUser;
    // Prod members keep their media connection during night — only regular players disconnect
    if (_cu && _cu.role === 'player' && !_cu.isProdMember) {
        // Disconnect from LiveKit so no audio/video passes through
        if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
        // Move to waiting room in Firebase so the room watcher stays disconnected
        if (_cu.id) {
            database.ref('players/' + _cu.id + '/room').set('waiting');
            _cu.room = 'waiting';
        }
    }
};

window.exitNight = function() {
    console.log('🌙 Exiting Night phase — restoring players to main room');
    const _cu = window.currentUser;
    if (_cu && _cu.role === 'player' && _cu.id) {
        // Restore player to main room — room watcher will reconnect LiveKit
        database.ref('players/' + _cu.id + '/room').set('main');
        _cu.room = 'main';
    }
};

// Called by PhaseManager when entering Breakfast phase
window.enterBreakfastPhase = function() {
    console.log('🍳 Entering Breakfast — disconnecting players from LiveKit');
    const _cu2 = window.currentUser;
    // Prod members keep their media connection during breakfast
    if (_cu2 && _cu2.role === 'player' && !_cu2.isProdMember) {
        if (typeof disconnectLiveKit === 'function') disconnectLiveKit();
        if (_cu2.id) {
            database.ref('players/' + _cu2.id + '/room').set('waiting');
            _cu2.room = 'waiting';
        }
    }
};

window.exitBreakfast = function() {
    console.log('🍳 Exiting Breakfast phase — restoring players to main room');
    window._breakfastSeatVisible = false;
    const _cu3 = window.currentUser;
    if (_cu3 && _cu3.role === 'player' && _cu3.id) {
        database.ref('players/' + _cu3.id + '/room').set('main');
        _cu3.room = 'main';
    }
};

// ── Room change watcher ───────────────────────────────────────
// Watches Firebase for room changes and joins/leaves LiveKit accordingly.
// Waits until currentUser is fully populated before attaching.
(function setupLiveKitRoomWatcher() {
    const trySetup = () => {
        const user = _lkCurrentUser();
        const uid  = user && user.id;
        if (!uid) {
            setTimeout(trySetup, 300);
            return;
        }

        // Skip for host — host has its own watcher above
        if (user && user.role === 'host') return;

        database.ref('players/' + uid + '/room').on('value', (snap) => {
            const room  = snap.val();
            const phase = sessionStorage.getItem('currentPhase');
            const isBreakoutRoom = room && room !== 'main' && room !== 'waiting';

            console.log('📹 Room changed to:', room, '| phase:', phase);

            // Always clear roomSeat from memory on any room change.
            // The new room's assignNewRoomSeat will set the correct value.
            if (window.currentUser) window.currentUser.roomSeat = null;
            // Also clear from gameState.players cache so _lkIdentityToSeat
            // doesn't return a stale roomSeat before Firebase propagates.
            const _myId = window.currentUser && window.currentUser.id;
            if (_myId && gameState && gameState.players && gameState.players[_myId]) {
                gameState.players[_myId].roomSeat = null;
            }

            // Observers with null room default to 'main' — their record may not
            // be written yet. Don't disconnect on null for observers.
            const _u2 = _lkCurrentUser();
            const _isObs = _u2 && (_u2.isObserver || _u2.role === 'observer');
            const _effectiveRoom = (!room && _isObs) ? 'main' : room;
            // Night: all players must be disconnected — no exceptions.
            // Breakfast: disconnect players who are in waiting (not yet invited).
            //            Players who have accepted the invite and have a seat CAN connect.
            const _overlayPhase = phase === 'night' || phase === 'breakfast';
            const _isNight = phase === 'night';
            const _invitedToBreakout = _overlayPhase &&
                room && room !== 'main' && room !== 'waiting';
            // A seated player in breakfast has accepted their invite — allow LiveKit
            const _u4 = _lkCurrentUser();
            const _hasSeatNow = _u4 && _u4.seat;
            const _breakfastSeated = (phase === 'breakfast') && _hasSeatNow &&
                _effectiveRoom === 'main';
            if (!_effectiveRoom || _effectiveRoom === 'waiting' ||
                (_isNight && !_invitedToBreakout) ||
                (phase === 'breakfast' && !_breakfastSeated && !_invitedToBreakout)) {
                disconnectLiveKit();
                return;
            }
            // Use effective room from here on
            const room2 = _effectiveRoom;

            // Only join if user has a name (fully registered)
            const u = _lkCurrentUser();
            const placeholderName = !u || !u.name || ['New Host', 'New Player'].includes(u.name);
            if (placeholderName) {
                // Name not set yet — wait a moment and retry
                setTimeout(() => joinLiveKitRoom(room2), 1000);
                return;
            }

            // Only block main room join if player has no seat AND not an overlay phase
            // AND not an observer/prod-member (they join muted without a seat).
            const _u3 = _lkCurrentUser();
            const _isProdOrObs = _u3 && (_u3.isProdMember || _u3.isObserver || _u3.role === 'observer');
            if (room2 === 'main' && (!u || !u.seat) && !_overlayPhase && !_isProdOrObs) {
                console.log('📹 Player in main room but no seat yet — waiting for seat before joining LiveKit');
                disconnectLiveKit();
                return;
            }

            joinLiveKitRoom(room2);
        });
    };

    trySetup();
})();

// ── Host: watch room changes and join LiveKit accordingly ───────
// Host's currentUser.id is 'host', stored at players/host in Firebase.
// hostJoinRoom() sets players/host/room — we watch that and join LiveKit.
(function setupHostLiveKitWatcher() {
    const trySetup = () => {
        const user = _lkCurrentUser();
        const isPlaceholder = !user || !user.name || user.role !== 'host'
            || ['New Host', 'New Player', 'Host'].includes(user.name);
        if (isPlaceholder) {
            setTimeout(trySetup, 300);
            return;
        }

        // Use correct Firebase path: prod members use their own ID, main host uses 'host'
        const _hostRoomPath = (user.id && user.id.startsWith('prod-')) 
            ? ('players/' + user.id + '/room')
            : 'players/host/room';
        let _lastJoinedLKRoom = null;
        database.ref(_hostRoomPath).on('value', (snap) => {
            const room    = snap.val() || 'main';
            const phase   = sessionStorage.getItem('currentPhase');
            const blocked = (phase === 'night' || phase === 'breakfast');

            console.log('📹 Host room changed to:', room, '| phase:', phase);

            if (blocked) { disconnectLiveKit(); _lastJoinedLKRoom = null; return; }

            // Skip if already connected/connecting to this same room
            if (room === _lastJoinedLKRoom && (window._lkRoom || window._lkConnecting)) {
                console.log('📹 Already connected to', room, '— skipping duplicate join');
                return;
            }
            _lastJoinedLKRoom = room;
            joinLiveKitRoom(room);
        });
    };
    trySetup();
})()


// Position AV controls just below the seat label, attached visually but not inside it
// _positionAVControls removed — buttons now positioned via CSS as 'shoulders' inside seat-label

// Re-position all visible AV controls (called after resize)
// _repositionAllAVControls removed

// ── AV Controls: show buttons on own seat, icons on all seats ─────────────────
// Re-apply AV icon state after any DOM rebuild (resize, phase change, room change).
// Called whenever seat HTML is regenerated so icons aren't stuck at display:none.
window._refreshAVIcons = function() {
    database.ref('players').once('value', (snap) => {
        const myId = window.currentUser && window.currentUser.id;
        const micState = {};
        const camState = {};
        const mySeats  = {};
        // Pre-populate our own seat from currentUser
        const _mySeat = window.currentUser && (window.currentUser.seat || window.currentUser.roomSeat);
        if (_mySeat) mySeats[_mySeat] = true;

        snap.forEach((child) => {
            const p = child.val();
            if (!p || !p.seat) return;
            let s = p.seat;
            if ((p.isHost || p.isProdMember) && typeof s === 'number') {
                s = p.isHost ? 'A' : (p.prodLetter || s);
            }
            micState[s] = !!p.audioMuted;
            camState[s] = !!p.videoMuted;
            if (myId && (child.key === myId || p.id === myId)) mySeats[s] = true;
        });
        // Main room seats
        const _allSeats = ['A']; // 'A' = main host seat
        for (let s = 1; s <= 25; s++) _allSeats.push(s);
        ['B','C','D'].forEach(l => _allSeats.push(l));
        for (const s of _allSeats) {
            const micIcon = document.getElementById('mic-off-' + s);
            const camIcon = document.getElementById('cam-off-' + s);
            const micBtn  = document.getElementById('mic-btn-' + s);
            const camBtn  = document.getElementById('cam-btn-'  + s);
            if (micIcon) micIcon.style.display = micState[s] ? 'flex' : 'none';
            if (camIcon) camIcon.style.display = camState[s] ? 'flex' : 'none';
            if (micBtn)  micBtn.classList.toggle('av-muted', !!(micState[s] && mySeats[s]));
            if (camBtn)  camBtn.classList.toggle('av-muted', !!(camState[s] && mySeats[s]));
        }
        // Reset ALL room seat AV icons first so departed players leave no traces
        for (let _rs = 1; _rs <= 8; _rs++) {
            const _rMicOff = document.getElementById('room-mic-off-' + _rs);
            const _rCamOff = document.getElementById('room-cam-off-' + _rs);
            if (_rMicOff) _rMicOff.style.display = 'none';
            if (_rCamOff) _rCamOff.style.display = 'none';
        }
        // Room seats — only for players in the room currently shown in the overlay.
        const _myRoom = window.hostCurrentRoom && window.hostCurrentRoom !== 'main'
            ? window.hostCurrentRoom
            : (window.currentUser && window.currentUser.room);
        snap.forEach((child) => {
            const rp = child.val();
            if (!rp || !rp.roomSeat || !rp.seat) return;
            if (!_myRoom || rp.room !== _myRoom) return; // wrong room — skip
            const rs = rp.roomSeat;
            const _rMicOff = document.getElementById('room-mic-off-' + rs);
            const _rCamOff = document.getElementById('room-cam-off-' + rs);
            if (_rMicOff) _rMicOff.style.display = !!rp.audioMuted ? 'flex' : 'none';
            if (_rCamOff) _rCamOff.style.display = !!rp.videoMuted ? 'flex' : 'none';
        });
    });
};

window.setupAVControls = function(seatNumber) {
    console.log('🎛️ setupAVControls called for seat:', seatNumber, '| currentUser:', window.currentUser && window.currentUser.id);
    // Hide ALL mic/cam buttons across every seat (A + 1-25 + B-J).
    // This clears any previously-shown buttons from a prior role (e.g. was host-A, now prod-C).
    const _allSeatIds = ['A','B','C','D'];
    for (let _s = 1; _s <= 25; _s++) _allSeatIds.push(_s);
    _allSeatIds.forEach((_s) => {
        if (String(_s) === String(seatNumber)) return; // skip our own seat
        const _mb = document.getElementById('mic-btn-' + _s);
        const _cb = document.getElementById('cam-btn-' + _s);
        if (_mb) _mb.style.display = 'none';
        if (_cb) _cb.style.display = 'none';
    });
    // Show control buttons on our own seat.
    // Try main room IDs first, then breakout room IDs.
    const _micBtn = document.getElementById('mic-btn-' + seatNumber)
                 || document.getElementById('room-mic-btn-' + seatNumber);
    const _camBtn = document.getElementById('cam-btn-' + seatNumber)
                 || document.getElementById('room-cam-btn-' + seatNumber);
    if (_micBtn) _micBtn.style.display = 'flex';
    if (_camBtn) _camBtn.style.display = 'flex';

    // Elevate the player's own seat above all others so the seat-label
    // (containing AV buttons) is never covered by adjacent seat elements.
    // Each seat is a stacking context (z-index:50); without this boost,
    // seats created later in DOM (lower rows) paint over earlier rows' labels.
    const _allSeatEls = ['A','B','C','D'];
    for (let _z = 1; _z <= 25; _z++) _allSeatEls.push(_z);
    _allSeatEls.forEach((_s) => {
        const _se = document.getElementById('seat-' + _s);
        if (!_se) return;
        if (String(_s) === String(seatNumber)) {
            _se.style.zIndex = '200'; // own seat above all others
        } else {
            _se.style.zIndex = ''; // let CSS z-index:50 apply for other seats
        }
    });

    // Only one global AV listener at a time — detach previous before adding
    if (window._avIconsListener) {
        database.ref('players').off('value', window._avIconsListener);
        window._avIconsListener = null;
    }

    // Capture seatNumber in closure — identifies our seat even before currentUser is set
    const _mySeatNumber = seatNumber;

    window._avIconsListener = database.ref('players').on('value', (snap) => {
        // Incremental update — build desired state first, then apply atomically.
        const myId     = window.currentUser && window.currentUser.id;
        const micState = {};   // seat → bool (muted)
        const camState = {};   // seat → bool (muted)
        const mySeats  = {};   // seat → bool (belongs to me)
        // Always mark our own seat as ours (works even if currentUser not yet set)
        mySeats[_mySeatNumber] = true;

        snap.forEach((child) => {
            const p = child.val();
            if (!p || !p.seat) return;
            // Sanitize: if host/prod have a corrupt numeric seat, use their correct letter
            let s = p.seat;
            if ((p.isHost || p.isProdMember) && typeof s === 'number') {
                s = p.isHost ? 'A' : (p.prodLetter || s);
            }
            micState[s] = !!p.audioMuted;
            camState[s] = !!p.videoMuted;
            // Also mark any additional seats this user owns (e.g. room seat)
            if (myId && (child.key === myId || p.id === myId)) mySeats[s] = true;
            // Main host: always owns seat A regardless of id field
            const _isMainHostKey = child.key === 'host' || (p.isHost && !p.isProdMember);
            const _iAmMainHost = myId && (myId === 'host' || 
                (window.currentUser && window.currentUser.isHost && !window.currentUser.isProdMember));
            if (_isMainHostKey && _iAmMainHost) mySeats[s] = true;
        });

        // Apply state to every seat that has DOM elements
        // Numeric seats (1-25) plus prod letter seats (B-J)
        const _allSeats = ['A']; // 'A' = main host seat
        for (let s = 1; s <= 25; s++) _allSeats.push(s);
        ['B','C','D'].forEach(l => _allSeats.push(l));
        for (const s of _allSeats) {
            const micIcon = document.getElementById('mic-off-' + s);
            const camIcon = document.getElementById('cam-off-' + s);
            const micBtn  = document.getElementById('mic-btn-' + s);
            const camBtn  = document.getElementById('cam-btn-'  + s);
            if (micIcon) micIcon.style.display = micState[s] ? 'flex' : 'none';
            if (camIcon) camIcon.style.display = camState[s] ? 'flex' : 'none';
            if (micBtn)  micBtn.classList.toggle('av-muted',  !!(micState[s] && mySeats[s]));
            if (camBtn)  camBtn.classList.toggle('av-muted',  !!(camState[s] && mySeats[s]));
        }

        // Update room seat AV icons for ALL players in breakout rooms.
        // Reset status icons only — not the toggle buttons (those are managed by setupAVControls).
        for (let _rs = 1; _rs <= 8; _rs++) {
            const _rMicOff = document.getElementById('room-mic-off-' + _rs);
            const _rCamOff = document.getElementById('room-cam-off-' + _rs);
            const _rMicBtn = document.getElementById('room-mic-btn-' + _rs);
            const _rCamBtn = document.getElementById('room-cam-btn-' + _rs);
            if (_rMicOff) _rMicOff.style.display = 'none';
            if (_rCamOff) _rCamOff.style.display = 'none';
            // Only reset the av-muted class — don't hide the buttons
            if (_rMicBtn) _rMicBtn.classList.remove('av-muted');
            if (_rCamBtn) _rCamBtn.classList.remove('av-muted');
        }
        // Scan all players for roomSeat assignments and update their room icons.
        // CRITICAL: only apply for players in the SAME room as the overlay currently shows.
        // Use hostCurrentRoom for the host (they watch rooms without entering them in currentUser),
        // fall back to currentUser.room for players.
        const _myCurrentRoom = window.hostCurrentRoom && window.hostCurrentRoom !== 'main'
            ? window.hostCurrentRoom
            : (window.currentUser && window.currentUser.room);
        snap.forEach((child) => {
            const rp = child.val();
            if (!rp || !rp.roomSeat || !rp.seat) return;
            if (!_myCurrentRoom || rp.room !== _myCurrentRoom) return; // wrong room
            const rs = rp.roomSeat; // room seat number (1-5)
            const ms = rp.seat;    // main seat (for mute state lookup)
            const _rMicOff = document.getElementById('room-mic-off-' + rs);
            const _rCamOff = document.getElementById('room-cam-off-' + rs);
            const _rMicBtn = document.getElementById('room-mic-btn-' + rs);
            const _rCamBtn = document.getElementById('room-cam-btn-' + rs);
            const _rMicMuted = !!rp.audioMuted;
            const _rCamMuted = !!rp.videoMuted;
            if (_rMicOff) _rMicOff.style.display = _rMicMuted ? 'flex' : 'none';
            if (_rCamOff) _rCamOff.style.display = _rCamMuted ? 'flex' : 'none';
            if (_rMicBtn) _rMicBtn.classList.toggle('av-muted', _rMicMuted);
            if (_rCamBtn) _rCamBtn.classList.toggle('av-muted', _rCamMuted);
            const _isMyRoomSeat = (window.currentUser && window.currentUser.roomSeat == rs
                && window.currentUser.seat == ms);
            // Show/hide shoulder buttons for local player's room seat
            const _rMicBtnShow = document.getElementById('room-mic-btn-' + rs);
            const _rCamBtnShow = document.getElementById('room-cam-btn-' + rs);
            if (_rMicBtnShow) _rMicBtnShow.style.display = _isMyRoomSeat ? 'flex' : 'none';
            if (_rCamBtnShow) _rCamBtnShow.style.display = _isMyRoomSeat ? 'flex' : 'none';
        });
    });
};


// Direct rooms-tab AV icon update for host/prod (no Firebase round-trip needed)
window._updateRoomsTabAVIcon = function(playerName, field, muted) {
    const color  = muted ? '#ff4444' : 'rgba(255,255,255,0.8)';
    const slash  = muted
        ? "<line x1='3' y1='3' x2='21' y2='21' stroke='#ff4444' stroke-width='2'/>"
        : '';
    // Mic path template (for rebuild)
    const micPath = "<path d='M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z'/>" +
        "<path d='M19 10v2a7 7 0 0 1-14 0v-2'/>" +
        "<line x1='12' y1='19' x2='12' y2='23'/>" +
        "<line x1='8' y1='23' x2='16' y2='23'/>";
    const camPath = "<polygon points='23 7 16 12 23 17 23 7'/>" +
        "<rect x='1' y='5' width='15' height='14' rx='2' ry='2'/>";

    // Guard: empty playerName would match every row
    if (!playerName) return;
    document.querySelectorAll('.room-players').forEach(el => {
        el.querySelectorAll('div[data-player-name]').forEach(row => {
            // Match exactly by data attribute — avoids substring false-positives
            if (row.dataset.playerName !== playerName) return;
            // Rebuild the SVG icons in this row
            const svgs = row.querySelectorAll('svg');
            if (svgs.length < 2) return;
            const isMicField = field === 'audioMuted';
            const svgIndex   = isMicField ? 0 : 1;
            const innerPath  = isMicField ? micPath : camPath;
            svgs[svgIndex].setAttribute('stroke', color);
            // Replace inner content to add/remove slash
            svgs[svgIndex].innerHTML = innerPath + slash;
        });
    });
};

window.toggleMic = function() {
    const user = window.currentUser;
    if (!user) { console.warn('🎤 toggleMic: no currentUser'); return; }
    // Block players from unmuting during night phase, or breakfast before seated
    if (user.role === 'player') {
        const _ph = (window._currentPhase || '').toLowerCase();
        const _micPubCheck = window._lkRoom && window._lkRoom.state === 'connected' &&
            window._lkRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        const _currentlyMuted = _micPubCheck && _micPubCheck.isMuted;
        const _tryingToUnmute = _currentlyMuted; // they're muted and pressing toggle = trying to unmute
        if (_tryingToUnmute) {
            if (_ph === 'night') {
                console.log('🎤 toggleMic blocked: night phase');
                return;
            }
            if (_ph === 'breakfast' && !user.seat) {
                console.log('🎤 toggleMic blocked: breakfast, not yet seated');
                return;
            }
        }
    }
    const room = window._lkRoom;
    if (!room || room.state !== 'connected') {
        console.warn('🎤 toggleMic: LiveKit not connected, state:', room && room.state);
        // For observers: also try toggling via Firebase only (no LiveKit track yet)
        if (user.isObserver || user.role === 'observer') {
            const _obsNowMuted = !!(user._localMuted);
            user._localMuted = !_obsNowMuted;
            database.ref('players/' + user.id + '/audioMuted').set(!_obsNowMuted);
            window._updateRoomsTabAVIcon(user.name || '', 'audioMuted', !_obsNowMuted);
            // Update floating mic button if present
            const _floatBtn = document.getElementById('obs-mic-btn');
            if (_floatBtn) _floatBtn.classList.toggle('av-muted', !_obsNowMuted);
        }
        return;
    }
    const micPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    if (!micPub) { console.warn('🎤 toggleMic: no mic track — published:', [...room.localParticipant.trackPublications.keys()]); return; }
    const nowMuted = micPub.isMuted;
    if (nowMuted) {
        micPub.unmute();
    } else {
        micPub.mute();
    }
    const newMuted = !nowMuted;
    // Host record: main host always writes to 'players/host' path.
    // Detect main host by isHost flag or by id='host' or id starting with 'host-' but NOT 'prod-'.
    const _isMainHost = user.isHost || user.id === 'host' || 
        (user.role === 'host' && user.id && !user.id.startsWith('prod-') && !user.isProdMember);
    const _avPlayerId = _isMainHost ? 'host' : user.id;
    database.ref('players/' + _avPlayerId + '/audioMuted').set(newMuted);
    const seat = user.seat;
    const btn = document.getElementById('mic-btn-' + seat);
    if (btn) { btn.classList.toggle('av-muted', newMuted); btn.style.display = 'flex'; }
    else { console.warn('🎤 toggleMic: mic-btn-' + seat + ' not found in DOM'); }
    const icon = document.getElementById('mic-off-' + seat);
    if (icon) icon.style.display = newMuted ? 'flex' : 'none';
    else { console.warn('🎤 toggleMic: mic-off-' + seat + ' not found in DOM'); }
    // Also update room seat icons if in breakout
    const _rSeat = user.roomSeat;
    if (_rSeat) {
        const rBtn = document.getElementById('room-mic-btn-' + _rSeat);
        if (rBtn) rBtn.classList.toggle('av-muted', newMuted);
        const rIcon = document.getElementById('room-mic-off-' + _rSeat);
        if (rIcon) rIcon.style.display = newMuted ? 'flex' : 'none';
    }
    // Directly update rooms tab for host/prod (bypasses Firebase timing)
    if (user.role === 'host' || user.isProdMember || user.role === 'observer') {
        window._updateRoomsTabAVIcon(user.name || '', 'audioMuted', newMuted);
    }
    // Update floating observer mic button if present
    const _fBtn = document.getElementById('obs-mic-btn');
    if (_fBtn) _fBtn.classList.toggle('av-muted', newMuted);
    console.log('🎤 Mic toggled:', newMuted ? 'muted' : 'unmuted');
};

window.toggleCam = function() {
    const user = window.currentUser;
    if (!user) { console.warn('📹 toggleCam: no currentUser'); return; }
    const room = window._lkRoom;
    if (!room || room.state !== 'connected') { console.warn('📹 toggleCam: LiveKit not connected, state:', room && room.state); return; }
    const camPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
    if (!camPub) { console.warn('📹 toggleCam: no cam track — published:', [...room.localParticipant.trackPublications.keys()]); return; }
    const nowMuted = camPub.isMuted;
    if (nowMuted) {
        camPub.unmute();
    } else {
        camPub.mute();
    }
    const newMuted = !nowMuted;
    const _isMainHostCam = user.isHost || user.id === 'host' || 
        (user.role === 'host' && user.id && !user.id.startsWith('prod-') && !user.isProdMember);
    const _avPlayerIdCam = _isMainHostCam ? 'host' : user.id;
    database.ref('players/' + _avPlayerIdCam + '/videoMuted').set(newMuted);
    const seat = user.seat;
    const btn = document.getElementById('cam-btn-' + seat);
    if (btn) { btn.classList.toggle('av-muted', newMuted); btn.style.display = 'flex'; }
    else { console.warn('📹 toggleCam: cam-btn-' + seat + ' not found in DOM'); }
    const icon = document.getElementById('cam-off-' + seat);
    if (icon) icon.style.display = newMuted ? 'flex' : 'none';
    else { console.warn('📹 toggleCam: cam-off-' + seat + ' not found in DOM'); }
    // Hide/show the local video element
    const videoDiv = document.getElementById('video-' + seat);
    if (videoDiv) videoDiv.style.opacity = newMuted ? '0' : '1';
    // Also update room seat icons if in breakout
    const _rSeatCam = user.roomSeat;
    if (_rSeatCam) {
        const rBtnC = document.getElementById('room-cam-btn-' + _rSeatCam);
        if (rBtnC) rBtnC.classList.toggle('av-muted', newMuted);
        const rIconC = document.getElementById('room-cam-off-' + _rSeatCam);
        if (rIconC) rIconC.style.display = newMuted ? 'flex' : 'none';
    }
    // Directly update rooms tab for host/prod
    if (user.role === 'host' || user.isProdMember) {
        window._updateRoomsTabAVIcon(user.name || 'Unknown', 'videoMuted', newMuted);
    }
    // Update mobile AV bar cam button
    const _mobCamBtn = document.getElementById('mobile-cam-btn');
    if (_mobCamBtn) {
        _mobCamBtn.style.background = newMuted ? 'rgba(180,30,30,0.9)' : 'rgba(40,40,40,0.9)';
        _mobCamBtn.style.borderColor = newMuted ? 'rgba(255,80,80,0.8)' : 'rgba(255,255,255,0.5)';
    }
    console.log('📹 Camera toggled:', newMuted ? 'off' : 'on');
};


// ── Audio Diagnostics ─────────────────────────────────────────────────────────
// Call window.diagAudio() from the browser console to inspect audio state
window.diagAudio = function() {
    const room = window._lkRoom;
    if (!room) { console.warn('🔇 No LiveKit room connected'); return; }

    console.group('🔊 LiveKit Audio Diagnostics');

    // AudioContext state
    console.log('Room state:', room.state);
    console.log('CanPlaybackAudio:', room.canPlaybackAudio);

    // Local participant
    const lp = room.localParticipant;
    console.group('👤 Local:', lp.identity);
    lp.trackPublications.forEach((pub) => {
        if (pub.kind === 'audio') {
            console.log('  Mic pub — muted:', pub.isMuted, '| enabled:', pub.track && pub.track.enabled, '| mediaStreamTrack readyState:', pub.track && pub.track.mediaStreamTrack && pub.track.mediaStreamTrack.readyState);
        }
    });
    console.groupEnd();

    // Remote participants
    room.remoteParticipants.forEach((p) => {
        console.group('👥 Remote:', p.identity);
        p.trackPublications.forEach((pub) => {
            if (pub.kind === 'audio') {
                console.log('  Audio pub — subscribed:', pub.isSubscribed, '| muted:', pub.isMuted, '| track:', !!pub.track);
                if (pub.track) {
                    const mst = pub.track.mediaStreamTrack;
                    console.log('  MediaStreamTrack — enabled:', mst && mst.enabled, '| readyState:', mst && mst.readyState, '| muted:', mst && mst.muted);
                }
            }
        });
        console.groupEnd();
    });

    // Injected <audio> elements
    const audioEls = document.querySelectorAll('audio[data-lk]');
    console.group('🎵 Injected <audio> elements:', audioEls.length);
    audioEls.forEach((el, i) => {
        console.log(`  [${i}] paused:${el.paused} muted:${el.muted} volume:${el.volume} readyState:${el.readyState} srcObject:${!!el.srcObject}`);
    });
    console.groupEnd();

    console.groupEnd();
};
console.log('💡 Run window.diagAudio() in console to diagnose audio issues');

// ── Cleanup on page unload ────────────────────────────────────
window.addEventListener('beforeunload', () => {
    disconnectLiveKit();
});

console.log('✅ LiveKit integration loaded');


// ============================================================
// END GAME BLOCK
// ============================================================
// NOTE: readyToRevealEndGameRole listener is in player.html (uses window.currentUser)
// All big text reveals use top:100px (directly below phase title at top:50px)

function clearVoteNameTag(seatNumber) {
    const nameEl     = document.getElementById('name-' + seatNumber);
    const pronounsEl = document.getElementById('pronouns-' + seatNumber);
    const seatLabel  = nameEl ? nameEl.parentElement : null;

    if (!nameEl || !seatLabel || !nameEl.dataset.showingVote) return;

    delete nameEl.dataset.showingVote;

    if (pronounsEl) {
        delete pronounsEl.dataset.showingVote;
        pronounsEl.style.visibility = '';
    }

    seatLabel.style.background  = '';
    nameEl.style.fontFamily     = '';
    nameEl.style.color          = '';
    nameEl.style.fontSize       = '';
    nameEl.style.visibility     = '';

    database.ref('players').orderByChild('seat').equalTo(seatNumber).once('value', (snap) => {
        snap.forEach((child) => {
            const p = child.val();
            nameEl.textContent = p.name || '';
            if (pronounsEl) pronounsEl.textContent = p.pronouns || '';
        });
    });
}

function clearAllVoteNameTags() {
    for (let s = 1; s <= 24; s++) clearVoteNameTag(s);
}

database.ref('game/endGame/clearNameTagsSignal').on('value', (snap) => {
    if (snap.val()) clearAllVoteNameTags();
});

// ── Smoke Vote ────────────────────────────────────────────────

function startSmokeVote() {
    showConfirmation('Start Smoke Vote', 'Enable players to cast their Smoke Vote?', 'Start', () => {
        database.ref('game/endGame/smokeVote').set({
            active:    true,
            votes:     {},
            locked:    {},
            timestamp: Date.now(),
        });
        const btn = document.getElementById('endgame-reveal-smoke-btn');
        if (btn) btn.disabled = false;
        const t = document.getElementById('smoke-vote-tally');
        if (t) t.textContent = 'Waiting for players...';
    });
}

function clearSmokeVote() {
    showConfirmation('Clear Smoke Vote', 'Clear all smoke votes?', 'Clear', () => {
        database.ref('game/endGame/smokeVote').remove();
        database.ref('game/endGame/smokeReveal').remove();
        database.ref('game/phaseTitle').set('End Game');
        database.ref('game/endGame/clearNameTagsSignal').set(Date.now());
        const btn = document.getElementById('endgame-reveal-smoke-btn');
        if (btn) btn.disabled = true;
        const nb = document.getElementById('smoke-next-btn');
        if (nb) nb.style.display = 'none';
        const t = document.getElementById('smoke-vote-tally');
        if (t) t.textContent = 'No smoke vote active';
    });
}

function revealSmokeVote() {
    database.ref('players').once('value', (snap) => {
        const seated = [];
        snap.forEach((child) => {
            const p = child.val();
            if (p.seat && !p.isHost) seated.push({ id: child.key, name: p.name, seat: p.seat });
        });
        if (!seated.length) { alert('No players found'); return; }

        document.getElementById('smoke-revealer-picker')?.remove();
        const ov = document.createElement('div');
        ov.id = 'smoke-revealer-picker';
        ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10001;display:flex;align-items:center;justify-content:center;';
        ov.innerHTML = `
            <div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.2);border-radius:12px;padding:28px 32px;max-width:480px;width:90%;text-align:center;">
                <h3 style="color:#FFD700;margin:0 0 8px;">Reveal Smoke Vote</h3>
                <p style="color:#bbb;margin:0 0 20px;font-size:0.9rem;">Who reveals first?</p>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;">
                    ${seated.map((p) => `
                        <button onclick="startSmokeRevealQueue('${p.id}')"
                            style="padding:10px 16px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.35);border-radius:8px;color:white;cursor:pointer;font-size:1rem;"
                            onmouseover="this.style.background='rgba(255,255,255,0.25)'"
                            onmouseout="this.style.background='rgba(255,255,255,0.1)'">${p.name}</button>
                    `).join('')}
                </div>
                <button onclick="document.getElementById('smoke-revealer-picker').remove();"
                    style="padding:8px 20px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#aaa;cursor:pointer;">Cancel</button>
            </div>`;
        document.body.appendChild(ov);
    });
}

function startSmokeRevealQueue(firstPlayerId) {
    document.getElementById('smoke-revealer-picker').remove();
    database.ref('game/endGame/clearNameTagsSignal').set(Date.now());
    database.ref('players').once('value', (snap) => {
        const all = [];
        snap.forEach((child) => {
            const p = child.val();
            if (p.seat && !p.isHost) all.push({ id: child.key, name: p.name, seat: p.seat });
        });
        all.sort((a, b) => a.seat - b.seat);
        const fi    = all.findIndex((p) => p.id === firstPlayerId);
        const queue = [...all.slice(fi), ...all.slice(0, fi)].map((p) => p.id);
        const firstName = all.find((p) => p.id === firstPlayerId)?.name || '';

        database.ref('game/endGame/smokeVote').update({
            revealActive:      true,
            revealQueue:       queue,
            revealIndex:       0,
            currentRevealerId: firstPlayerId,
        });
        database.ref('players/' + firstPlayerId + '/endGameReadyToRevealSmoke').set(true);
        database.ref('game/phaseTitle').set(firstName + ' has decided to...');
    });
}

function nextSmokeRevealer() {
    const nb = document.getElementById('smoke-next-btn');
    if (nb) nb.style.display = 'none';
    database.ref('game/endGame/smokeVote').once('value', (snap) => {
        const data = snap.val();
        if (!data || !data.revealQueue) return;
        const ni = (data.revealIndex || 0) + 1;
        if (ni >= data.revealQueue.length) {
            database.ref('game/phaseTitle').set('End Game');
            return;
        }
        const nid = data.revealQueue[ni];
        database.ref('game/endGame/smokeVote').update({ revealIndex: ni, currentRevealerId: nid });
        database.ref('players/' + nid + '/endGameReadyToRevealSmoke').set(true);
        database.ref('players/' + nid).once('value', (s) => {
            database.ref('game/phaseTitle').set((s.val()?.name || 'Next') + ' has decided to...');
        });
    });
}

// Smoke vote tally (host)
database.ref('game/endGame/smokeVote').on('value', (snap) => {
    const data = snap.val();
    const t    = document.getElementById('smoke-vote-tally');
    if (!t) return;
    if (!data || !data.active) { t.textContent = 'No smoke vote active'; return; }

    const votes  = data.votes  || {};
    const locked = data.locked || {};
    let e = 0, b = 0, tot = 0;
    Object.keys(locked).forEach((pid) => {
        if (!locked[pid]) return;
        tot++;
        if (votes[pid] === 'end')    e++;
        else if (votes[pid] === 'banish') b++;
    });
    // In viewer mode: hide the tally display
    if (localStorage.getItem('viewerModeEnabled') === 'true' && !data.revealActive) {
        t.textContent = 'Smoke vote in progress...';
    } else if (!data.revealActive) {
        t.innerHTML = `<span style="color:#4169E1">End: ${e}</span> &nbsp;|&nbsp; <span style="color:#DC143C">Banish: ${b}</span> &nbsp;|&nbsp; Locked: ${tot}`;
    }

    if (currentUser.role === 'host' && tot > 0 && !data.revealActive) {
        database.ref('players').once('value', (pSnap) => {
            pSnap.forEach((child) => {
                const p = child.val();
                if (!p.seat || !locked[child.key]) return;
                if (typeof showVoteOnNameTag === 'function') {
                    showVoteOnNameTag(p.seat, votes[child.key] === 'end' ? 'End' : 'Banish', true);
                }
            });
        });
    }
});

// Smoke reveal big text
database.ref('game/endGame/smokeReveal').on('value', (snap) => {
    const reveal = snap.val();
    if (!reveal || Date.now() - reveal.timestamp > 10000) return;
    window._endGameRevealActive = true; // allow viewer mode to show name box reveals
    const color = reveal.color || '#4169E1';

    document.getElementById('endgame-smoke-reveal-text')?.remove();
    const el = document.createElement('div');
    el.id = 'endgame-smoke-reveal-text';
    el.textContent = reveal.label || '';
    el.style.cssText = [
        'position:fixed', 'top:100px', 'left:50%', 'transform:translateX(-50%)',
        'font-size:5rem', 'font-weight:900',
        `color:${color}`, `text-shadow:0 0 40px ${color},0 0 80px ${color}`,
        'background:rgba(0,0,0,0.55)', 'padding:10px 36px', 'border-radius:14px',
        `border:2px solid ${color}88`, 'z-index:9500', 'opacity:0',
        'transition:opacity 0.5s', 'pointer-events:none', 'text-align:center',
        'white-space:nowrap', 'letter-spacing:0.06em', 'text-transform:uppercase',
    ].join(';');
    document.body.appendChild(el);

    setTimeout(() => { el.style.opacity = '1'; }, 10);
    setTimeout(() => { el.style.opacity = '0'; }, 3000);
    setTimeout(() => {
        el.remove();
        if (reveal.playerSeat && typeof showVoteOnNameTag === 'function') {
            showVoteOnNameTag(reveal.playerSeat, reveal.nameBoxLabel || reveal.label, true);
        }
        if (currentUser.role === 'host') {
            const nb = document.getElementById('smoke-next-btn');
            if (nb) nb.style.display = 'inline-block';
        }
    }, 3500);
});

// ── Banishment Vote ───────────────────────────────────────────

function _clearBanishFlags(cb) {
    database.ref('players').once('value', (snap) => {
        const updates = {};
        snap.forEach((child) => {
            updates['players/' + child.key + '/endGameReadyToRevealBanish'] = null;
        });
        if (Object.keys(updates).length) {
            database.ref().update(updates).then(() => { if (cb) cb(); });
        } else {
            if (cb) cb();
        }
    });
}

function startBanishmentVote() {
    showConfirmation('Begin Banishment', 'Start the Banishment vote?', 'Begin', () => {
        _clearBanishFlags(() => {
            database.ref('game/endGame/banishment').set({
                active: true, votes: {}, locked: {}, revealed: false, timestamp: Date.now(),
            });
            database.ref('game/endGame/banishmentTie').remove();
            database.ref('game/endGame/banishTiedSeats').remove();
            const btn = document.getElementById('endgame-reveal-banish-btn');
            if (btn) btn.disabled = false;
            const sec = document.getElementById('endgame-banish-tie-section');
            if (sec) sec.style.display = 'none';
        });
    });
}

function clearBanishmentVotes() {
    showConfirmation('Clear Banishment', 'Clear all banishment votes?', 'Clear', () => {
        database.ref('game/endGame/banishment').remove();
        database.ref('game/endGame/banishmentTie').remove();
        database.ref('game/endGame/banishTiedSeats').remove();
        database.ref('game/phaseTitle').set('End Game');
        database.ref('game/endGame/clearNameTagsSignal').set(Date.now());
        _clearBanishFlags();
        // Clear yellow/gold banishment reveal glows from all seats
        document.querySelectorAll('.video-seat').forEach(s => {
            s.style.boxShadow = '';
            s.style.border    = '';
        });
        ['endgame-reveal-banish-btn', 'endgame-reveal-banish-tie-btn'].forEach((id) => {
            const b = document.getElementById(id);
            if (b) b.disabled = true;
        });
        ['banish-next-btn', 'banish-tie-next-btn'].forEach((id) => {
            const b = document.getElementById(id);
            if (b) b.style.display = 'none';
        });
        const sec = document.getElementById('endgame-banish-tie-section');
        if (sec) sec.style.display = 'none';
    });
}

function startBanishmentTieVote() {
    showConfirmation('Second Banishment', 'Start second banishment vote?', 'Begin', () => {
        _clearBanishFlags(() => {
            database.ref('game/endGame/banishment/votes').once('value', (vSnap) => {
                const votes    = vSnap.val() || {};
                const counts   = {};
                Object.values(votes).forEach((seat) => {
                    counts[seat] = (counts[seat] || 0) + 1;
                });
                const vals      = Object.values(counts);
                const maxVotes  = vals.length ? Math.max(...vals) : 0;
                const tiedSeats = Object.entries(counts)
                    .filter(([, c]) => c === maxVotes)
                    .map(([s]) => parseInt(s));

                database.ref('game/endGame/clearNameTagsSignal').set(Date.now());
                database.ref('game/endGame/banishTiedSeats').set(tiedSeats, () => {
                    database.ref('game/endGame/banishmentTie').set({
                        active: true, votes: {}, locked: {}, revealed: false, timestamp: Date.now(),
                    });
                    const btn = document.getElementById('endgame-reveal-banish-tie-btn');
                    if (btn) btn.disabled = false;
                    const sec = document.getElementById('endgame-banish-tie-section');
                    if (sec) sec.style.display = 'block';
                });
            });
        });
    });
}

function startBanishmentReveal()    { _beginBanishRevealPicker('banishment'); }
function startBanishmentTieReveal() { _beginBanishRevealPicker('banishmentTie'); }

function _beginBanishRevealPicker(voteKey) {
    database.ref('game/endGame/' + voteKey).update({ revealed: true });
    setTimeout(() => {
        database.ref('game/endGame/' + voteKey).once('value', (snap) => {
            const data     = snap.val();
            if (!data) return;
            const locked   = data.locked || {};
            const voterIds = Object.keys(locked).filter((k) => locked[k]);
            if (!voterIds.length) { alert('No locked votes'); return; }

            database.ref('players').once('value', (pSnap) => {
                const voters = [];
                pSnap.forEach((child) => {
                    if (voterIds.includes(child.key)) {
                        voters.push({ id: child.key, name: child.val().name, seat: child.val().seat });
                    }
                });
                voters.sort((a, b) => a.seat - b.seat);

                document.getElementById('banish-revealer-picker')?.remove();
                const ov = document.createElement('div');
                ov.id = 'banish-revealer-picker';
                ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10001;display:flex;align-items:center;justify-content:center;';
                ov.innerHTML = `
                    <div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.2);border-radius:12px;padding:28px 32px;max-width:480px;width:90%;text-align:center;">
                        <h3 style="color:#FFD700;margin:0 0 8px;">Reveal ${voteKey === 'banishmentTie' ? 'Second ' : ''}Banishment Vote</h3>
                        <p style="color:#bbb;margin:0 0 20px;font-size:0.9rem;">Who reveals first?</p>
                        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;">
                            ${voters.map((p) => `
                                <button onclick="startBanishRevealQueue('${p.id}','${voteKey}')"
                                    style="padding:10px 16px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.35);border-radius:8px;color:white;cursor:pointer;font-size:1rem;"
                                    onmouseover="this.style.background='rgba(255,255,255,0.25)'"
                                    onmouseout="this.style.background='rgba(255,255,255,0.1)'">${p.name}</button>
                            `).join('')}
                        </div>
                        <button onclick="document.getElementById('banish-revealer-picker').remove();"
                            style="padding:8px 20px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#aaa;cursor:pointer;">Cancel</button>
                    </div>`;
                document.body.appendChild(ov);
            });
        });
    }, 300);
}

function startBanishRevealQueue(firstPlayerId, voteKey) {
    document.getElementById('banish-revealer-picker')?.remove();
    database.ref('game/endGame/' + voteKey).once('value', (snap) => {
        const locked   = (snap.val() || {}).locked || {};
        const voterIds = Object.keys(locked).filter((k) => locked[k]);
        database.ref('players').once('value', (pSnap) => {
            const voters = [];
            pSnap.forEach((child) => {
                if (voterIds.includes(child.key)) {
                    voters.push({ id: child.key, name: child.val().name, seat: child.val().seat });
                }
            });
            voters.sort((a, b) => a.seat - b.seat);
            const fi        = voters.findIndex((p) => p.id === firstPlayerId);
            const queue     = [...voters.slice(fi), ...voters.slice(0, fi)].map((p) => p.id);
            const firstName = voters.find((p) => p.id === firstPlayerId)?.name || '';

            database.ref('game/endGame/' + voteKey).update({ revealQueue: queue, revealIndex: 0 });
            database.ref('game/endGame/' + voteKey + '/currentRevealer').set(firstPlayerId);
            database.ref('players/' + firstPlayerId + '/endGameReadyToRevealBanish').set(true);
            database.ref('game/phaseTitle').set(firstName + ' voted for...');
        });
    });
}

function nextBanishRevealer(voteKey) {
    const nbId = voteKey === 'banishmentTie' ? 'banish-tie-next-btn' : 'banish-next-btn';
    const nb   = document.getElementById(nbId);
    if (nb) nb.style.display = 'none';

    database.ref('game/endGame/' + voteKey).once('value', (snap) => {
        const data = snap.val();
        if (!data || !data.revealQueue) return;
        const ni = (data.revealIndex || 0) + 1;
        if (ni >= data.revealQueue.length) {
            database.ref('game/phaseTitle').set('End Game');
            return;
        }
        const nid = data.revealQueue[ni];
        database.ref('game/endGame/' + voteKey).update({ revealIndex: ni });
        database.ref('game/endGame/' + voteKey + '/currentRevealer').set(nid);
        database.ref('players/' + nid + '/endGameReadyToRevealBanish').set(true);
        database.ref('players/' + nid).once('value', (s) => {
            database.ref('game/phaseTitle').set((s.val()?.name || 'Next') + ' voted for...');
        });
    });
}

function listenEndGameBanishTally(voteKey, elId) {
    // Guard: each voteKey gets exactly one persistent listener.
    // If this function is somehow called twice for the same key, skip the second registration.
    if (!window._banishTallyListeners) window._banishTallyListeners = {};
    if (window._banishTallyListeners[voteKey]) {
        console.log('⚠️ listenEndGameBanishTally: listener already registered for', voteKey, '— skipping duplicate');
        return;
    }
    window._banishTallyListeners[voteKey] = true;
    database.ref('game/endGame/' + voteKey).on('value', (snap) => {
        const data = snap.val();
        const el   = document.getElementById(elId);
        if (!el) return;
        if (!data || !data.active) { el.textContent = 'No votes yet'; return; }

        const votes  = data.votes  || {};
        const locked = data.locked || {};
        const counts = {};
        Object.keys(locked).forEach((pid) => {
            if (!locked[pid]) return;
            const t = votes[pid];
            if (!t) return;
            counts[t] = (counts[t] || 0) + 1;
        });
        if (!Object.keys(counts).length) { el.textContent = 'No votes yet'; return; }

        database.ref('players').once('value', (pSnap) => {
            const s2n = {};
            pSnap.forEach((child) => {
                const p = child.val();
                if (p.seat) s2n[p.seat] = p.name;
            });
            el.innerHTML = Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .map(([s, c]) => `
                    <div style="display:flex;justify-content:space-between;padding:3px 0;">
                        <span>${s2n[s] || 'Seat ' + s}</span>
                        <span style="color:#DC143C;font-weight:bold;">${c} vote${c !== 1 ? 's' : ''}</span>
                    </div>`)
                .join('');

            // Track reveal state for _isRevealPhase
        window._endGameRevealActive = !!(data && data.revealed);

        // In viewer mode: hide the tally (let reveals show individually on name boxes)
        if (localStorage.getItem('viewerModeEnabled') === 'true' && !data.revealed) {
            el.textContent = 'Banishment vote in progress...';
            return; // don't show tally or name tags while voting
        }

        if (currentUser.role === 'host' && !data.revealed) {
                pSnap.forEach((child) => {
                    const p  = child.val();
                    if (!p.seat || !locked[child.key]) return;
                    const tn = s2n[votes[child.key]] || 'Seat ' + votes[child.key];
                    if (typeof showVoteOnNameTag === 'function') showVoteOnNameTag(p.seat, tn, true);
                });
            }
        });
    });
}

listenEndGameBanishTally('banishment',    'endgame-banish-tally');
listenEndGameBanishTally('banishmentTie', 'endgame-banish-tie-tally');

// Show reveal button to the current revealer
['banishment', 'banishmentTie'].forEach((voteKey) => {
    database.ref('game/endGame/' + voteKey + '/currentRevealer').on('value', (snap) => {
        const revealerId = snap.val();
        const btn = document.getElementById('endgame-banish-reveal-btn');
        if (!btn) return;
        if (revealerId && revealerId === currentUser.id) {
            database.ref('game/endGame/' + voteKey + '/revealedVotes/' + currentUser.id)
                .once('value', (rSnap) => {
                    btn.style.display = rSnap.val() ? 'none' : 'block';
                });
        } else {
            // Only hide if this player's btn was shown by a previous voteKey listener
            if (btn.style.display === 'block') {
                // Check the OTHER key before hiding — don't hide if other key is our turn
                const otherKey = voteKey === 'banishment' ? 'banishmentTie' : 'banishment';
                database.ref('game/endGame/' + otherKey + '/currentRevealer').once('value', (os) => {
                    if (os.val() !== currentUser.id) btn.style.display = 'none';
                });
            }
        }
    });
});

// Belt-and-suspenders: also listen to per-player ready flag for banish reveal
if (currentUser && currentUser.role === 'player') {
    database.ref('players/' + currentUser.id + '/endGameReadyToRevealBanish').on('value', (snap) => {
        const btn = document.getElementById('endgame-banish-reveal-btn');
        if (!btn) return;
        if (snap.val() === true) btn.style.display = 'block';
    });
}

// Banishment reveal big text
['banishment', 'banishmentTie'].forEach((voteKey) => {
    database.ref('game/endGame/' + voteKey + '/revealedVotes').on('child_added', (snap) => {
        const data = snap.val();
        if (!data || Date.now() - (data.timestamp || 0) > 10000) return;

        // Ensure reveal flag is set so viewer mode allows name-box display
        window._endGameRevealActive = true;

        if (data.seat && data.votedFor && typeof showVoteOnNameTag === 'function') {
            showVoteOnNameTag(data.seat, data.votedFor, false);
        }

        document.getElementById('endgame-banish-reveal-text')?.remove();
        const el = document.createElement('div');
        el.id = 'endgame-banish-reveal-text';
        el.textContent = (data.votedFor || '').toUpperCase();
        el.style.cssText = [
            'position:fixed', 'top:100px', 'left:50%', 'transform:translateX(-50%)',
            'font-size:5rem', 'font-weight:900', 'color:white',
            'text-shadow:0 0 40px rgba(255,255,255,0.4)',
            'background:rgba(0,0,0,0.55)', 'padding:10px 36px', 'border-radius:14px',
            'border:2px solid rgba(255,255,255,0.35)', 'z-index:9500', 'opacity:0',
            'transition:opacity 0.5s', 'pointer-events:none', 'text-align:center',
            'white-space:nowrap', 'letter-spacing:0.06em', 'text-transform:uppercase',
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '1'; }, 10);
        setTimeout(() => { el.style.opacity = '0'; }, 3000);
        setTimeout(() => { el.remove(); }, 3500);

        if (data.name) database.ref('game/phaseTitle').set(data.name + ' voted for...');

        // Gold glow on the current revealer's seat
        if (data.seat) {
            document.querySelectorAll('.video-seat').forEach(s => {
                s.style.boxShadow = '';
                const circle = s.querySelector('circle');
                if (circle) circle.setAttribute('stroke', '#00FF00');
            });
            const _glowSeat = document.getElementById('seat-' + data.seat);
            if (_glowSeat) {
                _glowSeat.style.boxShadow = '0 0 40px 15px rgba(255, 215, 0, 1)';
                const _glowCircle = _glowSeat.querySelector('circle');
                if (_glowCircle) _glowCircle.setAttribute('stroke', '#FFD700');
            }
        }

        if (currentUser.role === 'host') {
            database.ref('game/endGame/' + voteKey).once('value', (vSnap) => {
                const vd    = vSnap.val() || {};
                const queue = vd.revealQueue || [];
                const idx   = vd.revealIndex  || 0;
                const nbId  = voteKey === 'banishmentTie' ? 'banish-tie-next-btn' : 'banish-next-btn';
                const nb    = document.getElementById(nbId);
                if (!nb) return;
                if (idx < queue.length - 1) {
                    nb.style.display = 'inline-block';
                    nb.onclick = () => nextBanishRevealer(voteKey);
                } else {
                    nb.style.display = 'none';
                    database.ref('game/phaseTitle').set('End Game');
                }
            });
        }
    });
});

// ── Tiebreaker Wheel ──────────────────────────────────────────

function startEndGameTiebreakerWheel() {
    const tryKey = (voteKey, fallback) => {
        database.ref('game/endGame/' + voteKey + '/votes').once('value', (vSnap) => {
            const votes = vSnap.val();
            if (votes && Object.keys(votes).length) {
                const counts   = {};
                Object.values(votes).forEach((seat) => { counts[seat] = (counts[seat] || 0) + 1; });
                const maxVotes  = Math.max(...Object.values(counts));
                const tiedSeats = Object.entries(counts)
                    .filter(([, c]) => c === maxVotes)
                    .map(([s]) => parseInt(s));
                if (typeof showTiebreakerWheel === 'function') showTiebreakerWheel(tiedSeats);
            } else if (fallback) {
                fallback();
            }
        });
    };
    tryKey('banishmentTie', () =>
        tryKey('banishment', () => {
            database.ref('players').once('value', (snap) => {
                const seats = [];
                snap.forEach((child) => {
                    const p = child.val();
                    if (p.seat && !p.isHost) seats.push(p.seat);
                });
                if (typeof showTiebreakerWheel === 'function') showTiebreakerWheel(seats);
            });
        })
    );
}

// ── Final Role Reveal ─────────────────────────────────────────

function startFinalRoleReveal() {
    database.ref('players').once('value', (snap) => {
        const players = [];
        snap.forEach((child) => {
            const p = child.val();
            if (p.seat && !p.isHost) players.push({ id: child.key, name: p.name, seat: p.seat });
        });
        if (!players.length) { alert('No players'); return; }

        players.sort((a, b) => a.seat - b.seat);
        window._endGameRoles  = {};
        window._revealOrder   = [...players];

        document.getElementById('role-assign-picker')?.remove();
        const ov = document.createElement('div');
        ov.id = 'role-assign-picker';
        ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.88);z-index:10001;display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:20px;box-sizing:border-box;';

        const roleRows = players.map((p) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;">
                <span style="font-weight:bold;color:white;min-width:80px;">${p.name}</span>
                <div style="display:flex;gap:6px;">
                    <button onclick="setEndGameRole('${p.id}','faithful',this)"
                        style="padding:6px 10px;background:#1a3a6b;border:2px solid #4169E1;border-radius:4px;color:white;cursor:pointer;font-size:0.8rem;">Faithful</button>
                    <button onclick="setEndGameRole('${p.id}','traitor',this)"
                        style="padding:6px 10px;background:#5a0010;border:2px solid #DC143C;border-radius:4px;color:white;cursor:pointer;font-size:0.8rem;">Traitor</button>
                </div>
            </div>`).join('');

        const orderItems = players.map((p, i) => `
            <div class="reveal-order-item" data-player-id="${p.id}" draggable="true"
                style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:8px;cursor:grab;user-select:none;transition:background 0.15s;">
                <span style="color:#888;font-size:0.85rem;min-width:20px;text-align:right;">${i + 1}.</span>
                <span style="color:#FFD700;font-size:0.9rem;">⠿</span>
                <span style="color:white;font-weight:bold;">${p.name}</span>
            </div>`).join('');

        ov.innerHTML = `
            <div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.2);border-radius:12px;padding:28px 32px;max-width:560px;width:95%;max-height:90vh;overflow-y:auto;">
                <h3 style="color:#FFD700;margin:0 0 6px;text-align:center;font-size:1.4rem;">Final Role Reveal</h3>
                <p style="color:#888;text-align:center;margin:0 0 20px;font-size:0.85rem;">Assign roles, then drag to set the reveal order.</p>
                <div style="display:flex;gap:16px;flex-wrap:wrap;">
                    <div style="flex:1;min-width:220px;">
                        <p style="color:#aaa;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 8px;">Assign Roles</p>
                        <div style="display:flex;flex-direction:column;gap:6px;">${roleRows}</div>
                    </div>
                    <div style="flex:1;min-width:160px;">
                        <p style="color:#aaa;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 8px;">Reveal Order <span style="color:#555;font-size:0.75rem;">(drag to reorder)</span></p>
                        <div id="reveal-order-list" style="display:flex;flex-direction:column;gap:6px;">${orderItems}</div>
                    </div>
                </div>
                <div style="display:flex;gap:10px;margin-top:20px;">
                    <button onclick="confirmFinalRoleReveal()"
                        style="flex:1;padding:11px;background:linear-gradient(135deg,#4169E1,#DC143C);border:none;border-radius:6px;color:white;font-weight:bold;cursor:pointer;font-size:1rem;">Confirm &amp; Begin Reveals</button>
                    <button onclick="document.getElementById('role-assign-picker').remove();"
                        style="padding:11px 16px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#aaa;cursor:pointer;">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(ov);

        const list = document.getElementById('reveal-order-list');
        let dragSrc = null;
        list.querySelectorAll('.reveal-order-item').forEach((item) => {
            item.addEventListener('dragstart', (e) => {
                dragSrc = item;
                item.style.opacity = '0.4';
                e.dataTransfer.effectAllowed = 'move';
            });
            item.addEventListener('dragend', () => {
                item.style.opacity = '1';
                list.querySelectorAll('.reveal-order-item').forEach((i) => {
                    i.style.background = 'rgba(255,255,255,0.07)';
                });
                _updateRevealOrderNumbers();
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                item.style.background = 'rgba(255,255,255,0.18)';
            });
            item.addEventListener('dragleave', () => {
                item.style.background = 'rgba(255,255,255,0.07)';
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                if (dragSrc !== item) {
                    const items  = [...list.querySelectorAll('.reveal-order-item')];
                    const srcIdx = items.indexOf(dragSrc);
                    const tgtIdx = items.indexOf(item);
                    if (srcIdx < tgtIdx) item.after(dragSrc);
                    else                 item.before(dragSrc);
                }
                item.style.background = 'rgba(255,255,255,0.07)';
                _updateRevealOrderNumbers();
            });
        });
    });
}

function _updateRevealOrderNumbers() {
    const list = document.getElementById('reveal-order-list');
    if (!list) return;
    const items = list.querySelectorAll('.reveal-order-item');
    items.forEach((item, i) => {
        const numEl = item.querySelector('span:first-child');
        if (numEl) numEl.textContent = (i + 1) + '.';
    });
    if (window._revealOrder) {
        const orderedIds = [...items].map((item) => item.dataset.playerId);
        window._revealOrder.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
    }
}

function setEndGameRole(pid, role, btn) {
    window._endGameRoles = window._endGameRoles || {};
    window._endGameRoles[pid] = role;
    btn.parentElement.querySelectorAll('button').forEach((b) => {
        b.style.opacity     = '0.5';
        b.style.borderWidth = '1px';
    });
    btn.style.opacity     = '1';
    btn.style.borderWidth = '3px';
    database.ref('players/' + pid + '/endGameRole').set(role);
}

function confirmFinalRoleReveal() {
    const roles = window._endGameRoles || {};
    if (!Object.keys(roles).length) { alert('Assign roles first'); return; }

    const list        = document.getElementById('reveal-order-list');
    const revealQueue = list
        ? [...list.querySelectorAll('.reveal-order-item')].map((item) => item.dataset.playerId)
        : (window._revealOrder || []).map((p) => p.id);
    if (!revealQueue.length) { alert('No players in reveal order'); return; }

    document.getElementById('role-assign-picker')?.remove();
    database.ref('game/endGame/finalReveal').set({
        active: true, roles, revealQueue, revealIndex: 0, timestamp: Date.now(),
    });

    const firstId = revealQueue[0];
    database.ref('players/' + firstId + '/readyToRevealEndGameRole').set(true);
    database.ref('players/' + firstId).once('value', (snap) => {
        database.ref('game/phaseTitle').set((snap.val()?.name || 'First') + ' is revealing their role...');
    });
    const b  = document.getElementById('endgame-display-winners-btn');
    if (b) b.disabled = false;
    const nb = document.getElementById('role-next-btn');
    if (nb) nb.style.display = 'none';
}

function nextRoleRevealer() {
    const nb = document.getElementById('role-next-btn');
    if (nb) nb.style.display = 'none';
    database.ref('game/endGame/finalReveal').once('value', (snap) => {
        const data = snap.val();
        if (!data || !data.revealQueue) return;
        const ni = (data.revealIndex || 0) + 1;
        if (ni >= data.revealQueue.length) {
            database.ref('game/phaseTitle').set('All roles revealed!');
            return;
        }
        const nid = data.revealQueue[ni];
        database.ref('game/endGame/finalReveal').update({ revealIndex: ni });
        database.ref('players/' + nid + '/readyToRevealEndGameRole').set(true);
        database.ref('players/' + nid).once('value', (s) => {
            database.ref('game/phaseTitle').set((s.val()?.name || 'Next') + ' is revealing their role...');
        });
    });
}

function clearWinnerDisplay() {
    showConfirmation('Clear Winner Display', 'Remove the winner display from all screens?', 'Clear', () => {
        database.ref('game/endGame/winners').remove();
        database.ref('game/phaseTitle').set('End Game');
    });
}

// Role reveal big text
database.ref('game/endGame/roleReveal').on('value', (snap) => {
    const r = snap.val();
    if (!r || Date.now() - r.timestamp > 15000) return;

    const rc = r.role === 'faithful' ? '#4169E1' : '#DC143C';
    const rt = r.role === 'faithful' ? 'FAITHFUL' : 'TRAITOR';

    document.getElementById('endgame-role-reveal-text')?.remove();
    const el = document.createElement('div');
    el.id = 'endgame-role-reveal-text';
    el.innerHTML = `
        <div style="color:white;font-size:2.5rem;margin-bottom:10px;">${r.playerName || ''} is a...</div>
        <div style="color:${rc};font-size:6rem;font-weight:900;letter-spacing:0.06em;">${rt}</div>`;
    el.style.cssText = [
        'position:fixed', 'top:100px', 'left:50%', 'transform:translateX(-50%)',
        'font-weight:bold', 'text-align:center', `text-shadow:0 0 20px ${rc}`,
        'background:rgba(0,0,0,0.55)', 'padding:20px 40px', 'border-radius:14px',
        `border:2px solid ${rc}88`, 'z-index:9500', 'opacity:0',
        'transition:opacity 0.5s', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '1'; }, 10);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, 8000);

    if (currentUser.role === 'host') {
        database.ref('game/endGame/finalReveal').once('value', (fSnap) => {
            const fd    = fSnap.val() || {};
            const queue = fd.revealQueue || [];
            const idx   = fd.revealIndex  || 0;
            const nb    = document.getElementById('role-next-btn');
            if (!nb) return;
            nb.style.display = idx < queue.length - 1 ? 'inline-block' : 'none';
        });
    }
});

// ── Winners Display ───────────────────────────────────────────

function showDisplayWinnersButton() {
    database.ref('game/endGame/finalReveal').once('value', (snap) => {
        const r = snap.val()?.roles || {};
        if (!Object.keys(r).length) {
            database.ref('players').once('value', (pSnap) => {
                const rr = {};
                pSnap.forEach((child) => {
                    const p = child.val();
                    if (p.seat && !p.isHost && p.endGameRole) rr[child.key] = p.endGameRole;
                });
                if (!Object.keys(rr).length) { alert('No roles assigned'); return; }
                _displayWinners(rr);
            });
            return;
        }
        _displayWinners(r);
    });
}

function _displayWinners(roles) {
    const ht        = Object.values(roles).some((r) => r === 'traitor');
    const wt        = ht ? 'traitor'      : 'faithful';
    const tc        = ht ? '#DC143C'      : '#4169E1';
    const teamLabel = ht ? 'TRAITORS WIN' : 'FAITHFUL WIN';

    database.ref('players').once('value', (pSnap) => {
        const ws = [];
        pSnap.forEach((child) => {
            const p = child.val();
            if ((roles[child.key] === wt || p.endGameRole === wt) && !ws.includes(p.name)) {
                ws.push(p.name);
            }
        });
        database.ref('game/endGame/winners').set({
            team: wt, teamColor: tc, teamLabel, winnerText: ws.join('  &  '), timestamp: Date.now(),
        });
    });
}

// Override performSmokeReveal and performBanishmentReveal once page is loaded
window.addEventListener('load', () => {
    window.performSmokeReveal = function() {
        const btn = document.getElementById('endgame-smoke-reveal-btn');
        if (btn) btn.style.display = 'none'; // hide immediately to prevent double-tap
        // Check this player's vote in Firebase (more reliable than btn.style check)
        database.ref('game/endGame/smokeVote').once('value', (smokeSnap) => {
            const smokeData = smokeSnap.val();
            if (!smokeData || !smokeData.revealActive) {
                if (btn) btn.style.display = 'block'; // restore if not in reveal
                return;
            }
            // Check it's actually this player's turn
            const isMyTurn = smokeData.currentRevealerId === currentUser.id;
            const voteData = (smokeData.votes || {})[currentUser.id];
            if (!isMyTurn && !voteData) {
                if (btn) btn.style.display = 'block';
                return;
            }
            const choice = voteData || null;
            const color  = choice === 'end' ? '#4169E1' : '#DC143C';
            database.ref('game/endGame/smokeReveal').set({
                playerId:      currentUser.id,
                playerSeat:    currentUser.seat,
                choice,
                label:         choice === 'end' ? 'END THE GAME' : 'BANISH',
                nameBoxLabel:  choice === 'end' ? 'End' : 'Banish',
                color,
                timestamp:     Date.now(),
            });
            database.ref('players/' + currentUser.id + '/endGameReadyToRevealSmoke').set(false);
        });
    };

    window.performBanishmentReveal = function() {
        const btn = document.getElementById('endgame-banish-reveal-btn');
        if (btn) btn.style.display = 'none'; // hide immediately to prevent double-tap
        const tryKey = (voteKey) => {
            database.ref('game/endGame/' + voteKey).once('value', (snap) => {
                const data = snap.val();
                if (!data || !data.revealed) return; // not in reveal phase
                const votedSeat = (data.votes || {})[currentUser.id];
                if (!votedSeat) return; // this player didn't vote in this round
                const alreadyRevealed = (data.alreadyRevealed || {})[currentUser.id];
                if (alreadyRevealed) return; // already revealed
                // Check it is actually this player's turn
                if (data.currentRevealer !== currentUser.id) {
                    if (btn) btn.style.display = 'block'; // restore — not our turn yet
                    return;
                }
                const seatNum = parseInt(votedSeat, 10);
                database.ref('players').once('value', (pSnap) => {
                    const players      = pSnap.val() || {};
                    const targetPlayer = Object.values(players).find((p) => p.seat === seatNum);
                    const votedFor     = targetPlayer ? targetPlayer.name : ('Seat ' + seatNum);
                    database.ref('game/endGame/' + voteKey + '/revealedVotes/' + currentUser.id).set({
                        seat: currentUser.seat, name: currentUser.name, votedFor, timestamp: Date.now(),
                    });
                    database.ref('game/endGame/' + voteKey + '/alreadyRevealed/' + currentUser.id).set(true);
                    database.ref('players/' + currentUser.id + '/endGameReadyToRevealBanish').set(false);
                });
            });
        };
        tryKey('banishment');
        tryKey('banishmentTie');
    };
});

// Winners listener — PHASE TITLE BAR update.
// NOTE: This is intentionally a SECOND .on('value') listener on game/endGame/winners.
// The first listener (near "END GAME — WINNERS DISPLAY") handles the full-screen overlay.
// This one handles the phase title bar (#phase-name) and the inline names display
// (#endgame-winners-names-display). Both must exist — they update different DOM elements.
database.ref('game/endGame/winners').on('value', (snap) => {
    const d       = snap.val();
    const phaseEl = document.getElementById('phase-name');
    const namesEl = document.getElementById('endgame-winners-names-display');

    if (!d) {
        if (phaseEl) {
            phaseEl.textContent  = 'End Game';
            phaseEl.style.color  = '';
            phaseEl.style.fontWeight   = '';
            phaseEl.style.textShadow   = '';
        }
        if (namesEl) { namesEl.style.display = 'none'; namesEl.innerHTML = ''; }
        return;
    }

    const tc = d.teamColor || '#FFD700';
    if (phaseEl) {
        phaseEl.textContent        = d.teamLabel || '';
        phaseEl.style.color        = tc;
        phaseEl.style.fontWeight   = '900';
        phaseEl.style.textShadow   = `0 0 20px ${tc}88`;
    }
    if (namesEl) {
        namesEl.innerHTML          = d.winnerText || '';
        namesEl.style.color        = tc;
        namesEl.style.textShadow   = `0 0 30px ${tc}88, 0 0 60px ${tc}44`;
        namesEl.style.display      = 'block';
    }
});

// Phase title listener
// Clear the HTML default immediately so it never flashes 'Waiting to Start'
(function() {
    const _pn = document.getElementById('phase-name');
    if (_pn && _pn.textContent === 'Waiting to Start') _pn.textContent = '';
})();

database.ref('game/phaseTitle').on('value', (snap) => {
    const t = snap.val();
    if (!t) return;
    // Don't apply end-game phaseTitles ('End Game', 'X voted for...') when
    // the current phase is lobby/voting — that's stale data from a prior session.
    const _phNow = window._currentPhase || sessionStorage.getItem('currentPhase') || '';
    const _isEndGameTitle = t === 'End Game' || t.includes('voted for') || t.includes('revealing their');
    const _isEndGamePhase = _phNow.startsWith('end') || _phNow.includes('banish') ||
                            _phNow.includes('smoke') || _phNow.includes('role-reveal');
    if (_isEndGameTitle && !_isEndGamePhase) return; // stale — ignore
    database.ref('game/endGame/winners').once('value', (wSnap) => {
        if (wSnap.val()) return;
        const el = document.getElementById('phase-name');
        if (el) {
            el.textContent        = t;
            el.style.color        = '';
            el.style.fontWeight   = '';
            el.style.textShadow   = '';
        }
    });
});