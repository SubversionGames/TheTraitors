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
    
    // Initialize video seats after page is fully stable
    setTimeout(() => {
        generateVideoSeats();
    }, 500);
    
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
                    if (players[playerId].seat) {
                        currentAssignments[playerId] = {
                            seat: players[playerId].seat,
                            name: players[playerId].name
                        };
                    }
                }
                
                // Update count
                window.currentMainSeatCount = newSeatCount;
                
                // Only regenerate if we've already generated seats once
                if (window.seatsGenerated) {
                    regenerateSeatsWithNewCount(newSeatCount);
                    
                    // Restore player assignments after a brief delay
                    setTimeout(() => {
                        for (let playerId in currentAssignments) {
                            const assignment = currentAssignments[playerId];
                            
                            // If player's seat still exists, restore to same seat
                            if (assignment.seat <= newSeatCount) {
                                database.ref('game/seats/' + assignment.seat).once('value', (seatSnap) => {
                                    if (!seatSnap.val()) {
                                        database.ref('game/seats/' + assignment.seat).set(playerId);
                                        console.log(`✅ Restored ${assignment.name} to seat ${assignment.seat}`);
                                    }
                                });
                            } else {
                                // Player's seat was removed - find first available seat
                                console.log(`⚠️ Seat ${assignment.seat} removed - finding new seat for ${assignment.name}`);
                                database.ref('game/seats').once('value', (seatsSnap) => {
                                    const seats = seatsSnap.val() || {};
                                    // Find first empty seat
                                    for (let i = 2; i <= newSeatCount; i++) {
                                        if (!seats[i]) {
                                            database.ref('game/seats/' + i).set(playerId);
                                            database.ref('players/' + playerId + '/seat').set(i);
                                            console.log(`✅ Moved ${assignment.name} to seat ${i}`);
                                            break;
                                        }
                                    }
                                });
                            }
                        }
                    }, 500);
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
                'waiting': 'Waiting to Start',
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
        
        // Force seats visible during lobby phase - with polling to ensure seats exist
        if (phase === 'lobby' && currentUser.role === 'player' && currentUser.room === 'main') {
            let attempts = 0;
            const checkSeats = setInterval(() => {
                const firstSeat = document.getElementById('seat-2');
                attempts++;
                
                if (firstSeat || attempts > 20) { // Try for max 1 second
                    clearInterval(checkSeats);
                    
                    if (firstSeat) {
                        document.querySelectorAll('.video-seat').forEach(seat => {
                            seat.style.display = 'flex';
                            seat.style.visibility = 'visible';
                            seat.style.opacity = '1';
                        });
                        console.log('✅ Seats forced visible in lobby phase');
                    } else {
                        console.error('❌ Seats never appeared after', attempts, 'attempts');
                    }
                }
            }, 50);
        }

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
                // Show breakfast overlay IMMEDIATELY
                if (overlay && overlayMessage) {
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
    let lastTimerValue = null;
    
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
            
            // Debounce: Only run if timer value actually changed
            const timerString = JSON.stringify(timer);
            console.log('🔍 Current timer string:', timerString);
            console.log('🔍 Last timer string:', lastTimerValue);
            
            if (timerString === lastTimerValue) {
                console.log('⏭️ Timer unchanged, skipping');
                return;
            }
            
            console.log('✅ Timer changed, processing...');
            lastTimerValue = timerString;
            
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
                'waiting': 'Waiting to Start',
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
                            
                            if (currentPhase === 'voting') {
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
    database.ref('players').on('value', (snapshot) => {
        const players = snapshot.val() || {};
        gameState.players = players;
        updatePlayerDisplay();
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
                return;
            }
            console.log('📊 Voting data:', voting);
            
            // Only show reveal controls if revealed is active
            if (voting.revealed && currentUser && currentUser.id) {
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
                hideRevealButton();
                document.removeEventListener('keydown', handleRevealKeypress);
            }
        };

        // Attach the listener
        database.ref('game/firstVote').on('value', window.votingListener);
        console.log('✅ Voting listener attached');

        // Listen for revote reveal updates
        database.ref('game/secondVoteReveal').on('value', (snapshot) => {
            const revoteRevealData = snapshot.val();
            const phaseName = document.getElementById('phase-name');
            
            console.log('🔄 REVOTE REVEAL LISTENER FIRED:', revoteRevealData);
            
            if (!phaseName) return;
            
            if (revoteRevealData && revoteRevealData.active) {
                // Get current revealer from revealOrder and currentIndex
                const currentIndex = revoteRevealData.currentIndex || 0;
                const revealOrder = revoteRevealData.revealOrder || [];
                const currentRevealerId = revealOrder[currentIndex];
                
                if (currentRevealerId) {
                    // During revote reveal, show which player is revealing
                    database.ref(`players/${currentRevealerId}`).once('value', (playerSnap) => {
                        const revealerData = playerSnap.val();
                        if (revealerData) {
                            phaseName.textContent = `${revealerData.name} is revealing their vote.`;
                            console.log(`🔄 REVOTE REVEAL: Phase title updated to "${revealerData.name} is revealing their vote."`);
                        }
                    });
                }
            } else {
                // Check if we're in revote phase (not reveal)
                database.ref('game/phase').once('value', (phaseSnap) => {
                    if (phaseSnap.val() === 'second-vote') {
                        phaseName.textContent = 'Revote Phase';
                        console.log('✅ REVOTE: Phase title set to "Revote Phase"');
                    }
                });
            }
        });
        console.log('✅ Revote reveal listener attached');

        // Listen for revote reveal to show reveal button
        database.ref('game/secondVoteReveal').on('value', (snapshot) => {
            const revoteRevealData = snapshot.val();
            
            console.log('🔄 REVOTE REVEAL BUTTON LISTENER:', revoteRevealData);
            
            // Remove purple glow from all seats when reveal starts
            if (revoteRevealData && revoteRevealData.active) {
                for (let i = 1; i <= 25; i++) {
                    const seat = document.getElementById(`seat-${i}`);
                    if (seat) {
                        // Remove purple glow
                        const currentShadow = seat.style.boxShadow;
                        if (currentShadow.includes('138, 43, 226')) {
                            seat.style.boxShadow = '';
                            seat.style.border = '';
                            console.log(`💜 Removed purple glow from seat ${i}`);
                        }
                    }
                }
            }
            
            if (!revoteRevealData || !revoteRevealData.active) {
                hideRevealButton();
                document.removeEventListener('keydown', handleRevealKeypress);
                removeGlowFromMySeat();
                return;
            }
            
            // Get current revealer from revealOrder and currentIndex
            const currentIndex = revoteRevealData.currentIndex || 0;
            const revealOrder = revoteRevealData.revealOrder || [];
            const currentRevealerId = revealOrder[currentIndex];
            
            console.log('🔄 REVOTE REVEAL: Checking if it\'s my turn');
            console.log('  Current index:', currentIndex);
            console.log('  Current revealer from revealOrder:', currentRevealerId);
            console.log('  My ID:', currentUser.id);
            
            // Check if it's my turn to reveal
            if (currentRevealerId === currentUser.id) {
                // Check if I have a second vote and haven't already revealed
                database.ref(`game/secondVote/votes/${currentUser.id}`).once('value', (voteSnap) => {
                    const votedSeat = voteSnap.val();
                    const alreadyRevealed = revoteRevealData.alreadyRevealed?.[currentUser.id];
                    
                    console.log('  My second vote:', votedSeat);
                    console.log('  Already revealed?:', alreadyRevealed);
                    
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
        console.log('✅ Revote reveal button listener attached');
        
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
    }

    function disableVotingClicks() {
        console.log('🚫 Disabling voting clicks');
        
        for (let i = 1; i <= 24; i++) {
            const seat = document.getElementById(`seat-${i}`);
            if (!seat) continue;
            
            seat.onclick = null;
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

    function castVote(seatNumber) {
        console.log('🗳️ Casting vote for seat:', seatNumber);
        
        // Check if voting is still active
        database.ref('game/firstVote').once('value', (snapshot) => {
            const voting = snapshot.val();
            if (!voting || !voting.active || voting.votingLocked) {
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
                } else {
                    // Store in both current and original for first vote
                    voteUpdates['game/firstVote/votes/' + currentUser.id] = seatNumber;
                    voteUpdates['game/firstVote/originalVotes/' + currentUser.id] = seatNumber;
                }
                
                database.ref().update(voteUpdates).then(() => {
                    console.log('✅ Vote recorded for player:', currentUser.id, 'voting for seat:', seatNumber);

                    // Show vote on name tag immediately
                    database.ref('players').once('value', (allPlayersSnap) => {
                        const targetPlayer = Object.values(allPlayersSnap.val() || {}).find(p => p.seat === seatNumber);
                        const targetName = targetPlayer ? targetPlayer.name : `Seat ${seatNumber}`;
                        
                        if (currentUser.role === 'player' && currentUser.seat) {
                            console.log('🎯 Showing vote on player name tag:', currentUser.seat, '→', targetName);
                            showVoteOnNameTag(currentUser.seat, targetName, true);
                        }
                    });
                });
            });
        });
    }

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
                nameElement.style.cssText = '';
            }
            if (pronounsElement && pronounsElement.dataset.showingVote) {
                delete pronounsElement.dataset.showingVote;
                pronounsElement.style.display = '';
                pronounsElement.style.cssText = '';
            }
            if (seatLabel && seatLabel.dataset.showingVote) {
                delete seatLabel.dataset.showingVote;
                seatLabel.style.cssText = '';
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
                nameElement.style.cssText = '';
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
        // TODO: Implement revote exit
    }

    // ============================================
    // REVOTE REVEAL PHASE (Stub - to be implemented)
    // ============================================

    function enterRevoteReveal() {
        console.log('📥 ENTERING REVOTE REVEAL PHASE');
        // TODO: Implement revote reveal phase
    }

    function exitRevoteReveal() {
        console.log('📤 EXITING REVOTE REVEAL PHASE');
        // TODO: Implement revote reveal exit
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
        
        // Remove all existing glows
        document.querySelectorAll('.video-seat').forEach(seat => {
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

function showVoteOnNameTag(seatNumber, votedForName, playerView) {
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

function updateRevealedVotesDisplay() {
    console.log('🔄 Updating revealed votes display');
    
    database.ref('game/voteReveal').once('value', (snapshot) => {
        const data = snapshot.val();
        if (!data || !data.revealedVotes) {
            console.log('⚠️ No revealed votes yet');
            return;
        }
        
        console.log('📋 ALL revealed so far:', data.revealedVotes);
        console.log('📊 Total count:', data.revealedVotes.length);
        
        database.ref('game/firstVote/votes').once('value', (votesSnap) => {
            const allVotes = votesSnap.val() || {};
            
            // CRITICAL: Only show the LAST player's vote (most recent)
            const justRevealedId = data.revealedVotes[data.revealedVotes.length - 1];
            console.log('🆕 Only processing player ID:', justRevealedId);
            
            // Show ONLY this one player's vote
            database.ref('players/' + justRevealedId).once('value', (playerSnap) => {
                const playerData = playerSnap.val();
                if (!playerData) {
                    console.log('❌ Player not found:', justRevealedId);
                    return;
                }
                
                const votedForSeat = allVotes[justRevealedId];
                if (votedForSeat) {
                    console.log(`✅ Player in seat ${playerData.seat} voted for seat ${votedForSeat}`);
                    
                    // Get the name of who they voted for
                    database.ref('players').once('value', (playersSnap) => {
                        const allPlayers = playersSnap.val() || {};
                        let votedForName = 'Unknown';
                        
                        // Find player name by seat number
                        for (const pid in allPlayers) {
                            if (allPlayers[pid].seat === votedForSeat) {
                                votedForName = allPlayers[pid].name;
                                break;
                            }
                        }
                        
                        console.log(`✅ Displaying: "${playerData.name}" → "${votedForName}"`);
                        
                        // CORRECT SYNTAX: seat number, voted-for name, is player view
                        showVoteOnNameTag(playerData.seat, votedForName, false);
                    });
                } else {
                    console.log(`⚠️ No vote found for player in seat ${playerData.seat}`);
                }
            });
        });
    });
}

// ============================================
// CIRCLE OF TRUTH PHASE (GLOBAL)
// ============================================

function handleCircleUpdate(snapshot) {
    const data = snapshot.val();
    
    console.log('🔍 Circle update received:', data);
    
    if (!data || !data.active) {
        console.log('❌ Circle of Truth not active');
        return;
    }
    
    console.log('🎯 Circle of Truth active for seat:', data.seatNumber);
    
    // Enlarge the selected player's seat FOR EVERYONE
    const seat = document.getElementById(`seat-${data.seatNumber}`);
    
    if (!seat) {
        console.error('❌ Seat element not found:', `seat-${data.seatNumber}`);
        return;
    }
    
    console.log('📏 Applying transform to seat', data.seatNumber);
    
    // Apply transform with higher specificity
    seat.style.transition = 'transform 0.5s ease';
    seat.style.transform = 'translate(-50%, -50%) scale(2.0)';
    seat.style.zIndex = '1000';
    
    // Counter-scale label
    const label = seat.querySelector('.seat-label');
    if (label) {
        label.style.transform = 'scale(0.5)';
        label.style.transformOrigin = 'center';
    }
    
    console.log('✅ Enlarged seat', data.seatNumber);
    
    // Reset all other seats
    for (let i = 1; i <= 25; i++) {
        if (i !== data.seatNumber) {
            const otherSeat = document.getElementById(`seat-${i}`);
            if (otherSeat) {
                otherSeat.style.transform = 'translate(-50%, -50%)';
                otherSeat.style.zIndex = '';
                
                const otherLabel = otherSeat.querySelector('.seat-label');
                if (otherLabel) {
                    otherLabel.style.transform = '';
                }
            }
        }
    }
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
        
        // Force phase element update immediately
        const phaseElement = document.getElementById('phase-name');
        if (phaseElement && phase) {
            const phaseNames = {
                'waiting': 'Waiting to Start',
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
        document.body.classList.add(`phase-${phase}`);
        
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
                database.ref('players').once('value', (snapshot) => {
                    snapshot.forEach((child) => {
                        const player = child.val();
                        if (child.key !== 'host' && player.room !== 'turret') {
                            // Send to waiting room and clear seat
                            database.ref('players/' + child.key).update({
                                room: 'waiting',
                                seat: null
                            });
                            
                            // Clear their seat in game/seats
                            if (player.seat) {
                                database.ref('game/seats/' + player.seat).remove();
                            }
                        }
                    });
                });
            }
        } else {
            hideNightOverlay();
            
            // For PLAYERS, show seats when leaving night phase (if not in waiting room)
            // But only for phases where seats should actually be shown
            const phasesWithSeats = ['lobby', 'circle-of-truth', 'first-vote', 'first-vote-reveal', 'second-vote', 'second-vote-reveal', 'talk', 'deliberation'];
            if (currentUser.role === 'player' && currentUser.room !== 'waiting' && phasesWithSeats.includes(phase)) {
                console.log('Leaving night phase - showing seats for player');
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
    overlay.style.width = '100%'; overlay.style.height = '100%'; overlay.style.zIndex = '9999';
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
    // Remove any existing player seats
    for (let i = 1; i <= 24; i++) {
        const existingSeat = document.getElementById(`seat-${i}`);
        if (existingSeat) existingSeat.remove();
    }
    
    // ============================================
    // DEFINE THREE SECTIONS OF THE PAGE
    // ============================================
    
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    
    // Define section widths as percentages (21% of viewport)
    const sectionWidthPercent = 12; // Each side section is 12% of viewport
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
    const bottomBorderY = viewportHeight - 50;
    
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
    const minPlayerSize = 80; // Minimum 80px for mobile
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
    cols = 8; // Always 8 columns

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
                // Special handling for 3 rows to get 8-8-8 -> 8-7-8 -> 7-8-7 -> 7-7-7
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
    
    seats.forEach(seat => {
        const seatElement = document.createElement('div');
        seatElement.className = 'video-seat empty';
        seatElement.id = `seat-${seat.number}`;
        seatElement.style.position = 'fixed';
        seatElement.style.left = `${seat.x}px`;
        seatElement.style.top = `${seat.y}px`;
        seatElement.style.width = `${seat.size}px`;
        seatElement.style.height = `${seat.size}px`;
        seatElement.style.transform = 'translate(-50%, -50%)';
        
        // Name tag below seat
        const labelStyle = 'position: absolute; top: calc(100% + 5px); left: 50%; transform: translateX(-50%); white-space: nowrap;';
        
        seatElement.innerHTML = `
            <div id="video-${seat.number}"></div>
            <div class="seat-label" id="seat-label-${seat.number}">
                <span class="player-name" id="name-${seat.number}">Empty</span>
                <span class="player-pronouns" id="pronouns-${seat.number}"></span>
            </div>
            <div class="seat-av-controls" id="av-controls-${seat.number}" style="display:none">
                <button class="av-btn mic-btn" id="mic-btn-${seat.number}" title="Toggle Mic (M)" onclick="event.stopPropagation(); window.toggleMic && window.toggleMic()">
                    <svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                </button>
                <button class="av-btn cam-btn" id="cam-btn-${seat.number}" title="Toggle Camera (V)" onclick="event.stopPropagation(); window.toggleCam && window.toggleCam()">
                    <svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
                </button>
            </div>
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
        `;
        
        seatElement.addEventListener('click', (e) => {
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
            
            // Normal seat claiming
            handleSeatClick(seat.number);
        });
        document.body.appendChild(seatElement);
    });
    
    console.log(`Generated 24 player seats in 8x3 grid layout`);

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
                
                // Name tag
                const nameTag = document.createElement('div');
                nameTag.className = 'seat-label';
                nameTag.innerHTML = `
                    <span id="room-name-${seatIndex}" class="player-name">Empty</span>
                    <span id="room-pronouns-${seatIndex}" class="player-pronouns"></span>
                `;
                
                seatElement.appendChild(videoDiv);
                seatElement.appendChild(nameTag);
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
            
            // Update room name display
            const roomNames = {
                'kitchen': 'Kitchen',
                'library': 'Library',
                'living': 'Living Room',
                'courtyard': 'Courtyard',
                'bathroom': 'Bathroom',
                'gym': 'Gym',
                'turret': 'The Turret'
            };
            
            const roomNameEl = document.getElementById('room-name-display');
            if (roomNameEl) {
                roomNameEl.textContent = roomNames[roomId] || roomId;
            }
            
            generateRoomSeats(roomId, seatLimit);

            // ── Populate room seat names from Firebase ───────────────────
            if (window._roomNamesListener) {
                database.ref('players').off('value', window._roomNamesListener);
            }
            window._roomNamesListener = database.ref('players').on('value', (pSnap) => {
                for (let s = 1; s <= seatLimit; s++) {
                    const nameEl = document.getElementById('room-name-' + s);
                    const pronEl = document.getElementById('room-pronouns-' + s);
                    if (nameEl) nameEl.textContent = 'Empty';
                    if (pronEl) pronEl.textContent = '';
                }
                pSnap.forEach((child) => {
                    const p = child.val();
                    if (!p || p.room !== roomId || !p.roomSeat) return;
                    const nameEl = document.getElementById('room-name-' + p.roomSeat);
                    const pronEl = document.getElementById('room-pronouns-' + p.roomSeat);
                    if (nameEl) nameEl.textContent = p.name || 'Player';
                    if (pronEl) pronEl.textContent = p.pronouns || '';
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
        // Center host in left section, matching left margin distance from top
        const hostX = leftSectionWidth / 2;
        const hostY = leftSectionWidth / 2; // Halfway down the left section
        
        // Constrain host size to fit in left section
        const maxHostSize = leftSectionWidth - 40; // 20px margin on each side
        const actualHostSize = Math.min(finalHostSize, maxHostSize);
        
        hostSeat.style.position = 'fixed';
        hostSeat.style.left = `${hostX}px`;
        hostSeat.style.top = `${hostY}px`;
        hostSeat.style.width = `${actualHostSize}px`;
        hostSeat.style.height = `${actualHostSize}px`;
        hostSeat.style.transform = 'translate(-50%, -50%)';
        
        console.log(`Host positioned in left section: (${hostX.toFixed(0)}, ${hostY}) with size ${actualHostSize.toFixed(0)}px`);

        // Make seat-A clickable for prod members to request switch with main host
        if (hostSeat && !hostSeat._switchHandlerAdded) {
            hostSeat._switchHandlerAdded = true;
            hostSeat.addEventListener('click', (e) => {
                if (!window.currentUser || !window.currentUser.seat) return;
                const mySeat = window.currentUser.seat;
                if (mySeat === 'A') return; // already main host
                if (!['B','C','D','E','F','G','H','I','J'].includes(String(mySeat))) return;
                _showSeatSwitchMenu('A', e.clientX, e.clientY);
            });
        }

        // Position production member seats below the main host
        _positionProdSeats(hostX, hostY, actualHostSize, finalPlayerSize, leftSectionWidth);
        
        console.log(`Host positioned at top-left: (${hostX}, ${hostY}) with size ${finalHostSize}px`);
    }
    
    // Re-attach rename handlers if function exists
    if (typeof attachRenameHandlers === 'function') {
        setTimeout(() => attachRenameHandlers(), 100);
    }

    // Re-show remove buttons if seat remove mode is active
    if (typeof seatRemoveModeActive !== 'undefined' && seatRemoveModeActive) {
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
        
        // Step 2: Remove all existing player seats (but not host seat)
        const existingSeats = document.querySelectorAll('.video-seat:not(.host)');
        existingSeats.forEach(seat => seat.remove());
        
        // Step 3: Regenerate with new count
        generateVideoSeats();
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
            }

            // Move video element to new seat if it exists
            if (oldSeat && oldSeat !== seatNumber) {
                const oldVideoDiv = document.getElementById(`video-${oldSeat}`);
                const newVideoDiv = document.getElementById(`video-${seatNumber}`);
                
                if (oldVideoDiv && newVideoDiv && oldVideoDiv.children.length > 0) {
                    // Move all video elements from old seat to new seat
                    while (oldVideoDiv.firstChild) {
                        newVideoDiv.appendChild(oldVideoDiv.firstChild);
                    }
                    console.log('📹 Moved video from seat', oldSeat, 'to seat', seatNumber);
                }
            }

            // LiveKit handles video/audio automatically via the room watcher
        }).catch((error) => {
            if (error !== 'Seat taken') {
                console.error('Error claiming seat:', error);
            }
        });
    }

// ============================================
// PLAYER DISPLAY UPDATES
// ============================================

    function updatePlayerDisplay() {
        // Update main host seat (seat-A)
        const _hostPlayer = Object.values(gameState.players || {}).find(
            p => p.seat === 'A' || (p.isHost && !p.isProdMember)
        );
        if (_hostPlayer) {
            const _nameA = document.getElementById('name-A');
            const _pronA = document.getElementById('pronouns-A');
            if (_nameA && _nameA.textContent !== _hostPlayer.name) {
                _nameA.textContent = _getDisplayName('A', _hostPlayer.name || 'Host');
            }
            if (_pronA) _pronA.textContent = _hostPlayer.pronouns || '';
        }

        // Also update prod member seats (letter seats B-J)
        ['B','C','D','E','F','G','H','I','J'].forEach(letter => {
            const nameEl = document.getElementById('name-' + letter);
            if (!nameEl) return;
            // Find prod member in Firebase data
            const prodPlayer = Object.values(gameState.players || {}).find(
                p => p.seat === letter && p.isProdMember
            );
            if (prodPlayer) {
                nameEl.textContent = _getDisplayName(letter, prodPlayer.name || letter);
                const pronEl = document.getElementById('pronouns-' + letter);
                if (pronEl) pronEl.textContent = prodPlayer.pronouns || '';
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
                    nameElement.style.fontSize = '1.2rem';
                    nameElement.style.fontFamily = 'Arial, sans-serif'; // ← Normal font for names
                    console.log(`✅ Updated seat ${i} with name: ${playerInSeat.name}`);
                }

                if (seatLabel && !seatLabel.dataset.showingVote) {
                    seatLabel.style.cssText = ''; // Reset background
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
            } else {
                seatElement.classList.add('empty');
                seatElement.classList.remove('active');
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
            }
        }
    }

    // ============================================
    // VOTE TALLY SYSTEM - COMPLETE REWRITE
    // ============================================
    
    // Listen for ORIGINAL votes (never cleared)
    database.ref('game/firstVote/originalVotes').on('value', (snapshot) => {
        const votes = snapshot.val();
        if (currentUser.role === 'host' && votes) {
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
    
    // Listen for CURRENT votes (used during revote) - HOST ONLY
    // DELAYED to ensure seats exist first
    setTimeout(() => {
        database.ref('game/firstVote/votes').on('value', (snapshot) => {
            const votes = snapshot.val();
            console.log('🎯 Host updating vote displays:', votes);
        
            if (!votes) return;
        
            // Determine if this is a revote
            database.ref('game/firstVote/isRevote').once('value', (revoteSnapshot) => {
                const isRevote = revoteSnapshot.val() || false;
                
                if (currentUser.role === 'host') {
                    // Show/hide revote sections
                    const revoteSection = document.getElementById('revote-section');
                    const revoteRevealSection = document.getElementById('revote-reveal-section');
                    
                    if (isRevote) {
                        // During revote, show revote sections and update revote total
                        if (revoteSection) revoteSection.style.display = 'block';
                        updateVoteTally(votes, 'revote-total');
                    } else {
                        // During original vote, hide revote sections
                        if (revoteSection) revoteSection.style.display = 'none';
                        if (revoteRevealSection) revoteRevealSection.style.display = 'none';
                    }
                    
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
        });
    }, 2000); // Close setTimeout - wait for seats to generate

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

// Update Reveal Count as votes are revealed (for host)
database.ref('game/revealedVoteDisplay').on('value', (snapshot) => {
    if (currentUser.role !== 'host') return;
    
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
    
    // Display reveal tally
    if (Object.keys(revealCounts).length === 0) {
        revealCountElement.innerHTML = '<div style="color: #666;">No votes revealed yet</div>';
        return;
    }
    
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

// PLAYER: Listen for FIRST VOTE revealed votes to update vote count display
database.ref('game/revealedVoteDisplay').on('value', (snapshot) => {
    if (currentUser.role !== 'player') return;
    
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
        
        if (Object.keys(revealCounts).length === 0) {
            revealCountElement.innerHTML = '<p style="color: #bbb; text-align: center;">No votes revealed yet</p>';
            return;
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
    const revealedVotes = snapshot.val() || {};
    
    console.log('🎯 SECOND VOTE REVEALS updated:', revealedVotes);
    
    // Skip if no data
    if (Object.keys(revealedVotes).length === 0) return;
    
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
    const isInDifferentRoom = playerData.room && playerData.room !== 'main';
    
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
                _repositionAllAVControls();
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

// Host sees all votes in real-time on name tags
if (currentUser && currentUser.role === 'host') {
    database.ref('game/firstVote/votes').on('value', (snapshot) => {
        const votes = snapshot.val();
        if (!votes) return;
        
        console.log('🎯 Host updating vote displays:', votes);
        
        // Show each vote on name tag
        Object.keys(votes).forEach(voterId => {
            const votedForSeat = votes[voterId];
            
            database.ref('players/' + voterId).once('value', (voterSnap) => {
                const voter = voterSnap.val();
                if (!voter || !voter.seat) return;
                
                database.ref('players').once('value', (allPlayersSnap) => {
                    const targetPlayer = Object.values(allPlayersSnap.val() || {}).find(p => p.seat === votedForSeat);
                    const targetName = targetPlayer ? targetPlayer.name : `Seat ${votedForSeat}`;
                    
                    showVoteOnNameTag(voter.seat, targetName, false);
                });
            });
        });
    });
}

// Show auto-votes on player's own screen
database.ref('game/autoVoteDisplay/' + currentUser.id).on('value', (snapshot) => {
    const data = snapshot.val();
    if (data && currentUser.role === 'player') {
        showVoteOnNameTag(data.seat, data.name, true);
    }
});

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
        
        // Clear all vote displays
        for (let i = 1; i <= 25; i++) {
            const nameElement = document.getElementById(`name-${i}`);
            const pronounsElement = document.getElementById(`pronouns-${i}`);
            const seatLabel = nameElement ? nameElement.parentElement : null;
            
            if (nameElement && nameElement.dataset.showingVote) {
                delete nameElement.dataset.showingVote;
                nameElement.style.cssText = '';
            }
            if (pronounsElement && pronounsElement.dataset.showingVote) {
                delete pronounsElement.dataset.showingVote;
                pronounsElement.style.display = '';
                pronounsElement.style.cssText = '';
            }
            if (seatLabel && seatLabel.dataset.showingVote) {
                delete seatLabel.dataset.showingVote;
                seatLabel.style.cssText = '';
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
                    
                    // Also restore name tag size
                    const seatLabel = seatElement.querySelector('.seat-label');
                    if (seatLabel) {
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
            nameElement.style.cssText = '';
        }
        if (pronounsElement && pronounsElement.dataset.showingVote) {
            delete pronounsElement.dataset.showingVote;
            pronounsElement.style.display = '';
            pronounsElement.style.cssText = '';
        }
        if (seatLabel && seatLabel.dataset.showingVote) {
            delete seatLabel.dataset.showingVote;
            seatLabel.style.cssText = '';
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
database.ref('game/endGame/winners').on('value', (snapshot) => {
    const data = snapshot.val();
    const overlay = document.getElementById('endgame-winners-overlay');
    if (!overlay) return;
    if (!data) { overlay.style.display = 'none'; return; }
    const teamNameEl = document.getElementById('winners-team-name');
    const playerNamesEl = document.getElementById('winners-player-names');
    if (teamNameEl) { teamNameEl.textContent = data.teamName || ''; teamNameEl.style.color = data.teamColor || '#FFD700'; }
    if (playerNamesEl) { playerNamesEl.textContent = data.winnerText || ''; playerNamesEl.style.color = data.teamColor || '#FFD700'; }
    overlay.style.display = 'flex';
});
// ── Production Member Seats ──────────────────────────────────────────────────
// Prod members get letter seats (B, C, D...) positioned in the left column
// below the main host seat. Each gets a video circle the same size as player seats.

function _positionProdSeats(hostX, hostY, hostSize, playerSize, leftSectionWidth) {
    const letters = ['B','C','D','E','F','G','H','I','J'];
    const margin = 8; // gap between seats

    // Watch Firebase for prod members and create/update their seats
    database.ref('players').orderByChild('isProdMember').equalTo(true).on('value', (snap) => {
        // Collect active prod members sorted by seat letter
        const prodMembers = [];
        snap.forEach(child => {
            const p = child.val();
            if (p && p.seat && p.status !== 'removed') prodMembers.push(p);
        });
        prodMembers.sort((a, b) => a.seat.localeCompare(b.seat));

        // Remove prod seats that are no longer active
        const _activeLetters = prodMembers.map(p => p.seat);
        document.querySelectorAll('.prod-seat').forEach(el => {
            const letter = el.id.replace('seat-', '');
            if (!_activeLetters.includes(letter)) el.remove();
        });

        // Create and position a seat for each prod member
        // --- Dynamic scaling: shrink seats/spacing if they'd go off-screen ---
        const _n = prodMembers.length;
        const _gap0 = hostSize / 2 + 110 + playerSize / 2; // host→first seat
        const _spacing0 = playerSize + 90; // center-to-center between seats
        const _bottomMargin = 80; // px from bottom of window
        const _availableHeight = window.innerHeight - (hostY + _gap0) - _bottomMargin;
        // Height needed from first seat center to last seat center
        const _neededHeight = (_n - 1) * _spacing0;
        // Scale factor: shrink if needed, never enlarge
        const _scale = (_n > 1 && _neededHeight > _availableHeight)
            ? Math.max(0.45, _availableHeight / _neededHeight)
            : 1.0;
        const _scaledSpacing = _spacing0 * _scale;
        const _scaledSize = playerSize * _scale;
        // Also scale the initial gap slightly when squishing
        const _scaledGap = _scale < 1
            ? (hostSize / 2 + Math.max(50, 110 * _scale) + _scaledSize / 2)
            : _gap0;

        prodMembers.forEach((p, idx) => {
            const letter = p.seat; // 'B', 'C', etc.
            const seatId = 'seat-' + letter;

            // Use scaled gap and spacing
            const gap = _scaledGap;
            const y = hostY + gap + idx * _scaledSpacing;
            const x = hostX; // same X as host (centered in left column)

            // Constrain to left section; use scaled size
            const maxSize = leftSectionWidth - 20;
            const size = Math.min(_scaledSize, maxSize);

            let seatEl = document.getElementById(seatId);
            if (!seatEl) {
                seatEl = document.createElement('div');
                seatEl.id = seatId;
                seatEl.className = 'video-seat prod-seat';
                seatEl.innerHTML = `
                    <div id="video-${letter}"></div>
                    <div class="seat-label" id="seat-label-${letter}">
                        <span class="player-name" id="name-${letter}">${p.name || letter}</span>
                        <span class="player-pronouns" id="pronouns-${letter}">${p.pronouns || ''}</span>
                    </div>
                    <div class="seat-av-controls" id="av-controls-${letter}" style="display:none">
                        <button class="av-btn mic-btn" id="mic-btn-${letter}" title="Toggle Mic (M)" onclick="event.stopPropagation(); window.toggleMic && window.toggleMic()"><svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></button>
                        <button class="av-btn cam-btn" id="cam-btn-${letter}" title="Toggle Camera (V)" onclick="event.stopPropagation(); window.toggleCam && window.toggleCam()"><svg viewBox="0 0 24 24" fill="white" width="14" height="14"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></button>
                    </div>
                    <div class="av-status-icons" id="av-status-${letter}">
                        <span class="av-icon mic-off-icon" id="mic-off-${letter}" style="display:none"><svg viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></span>
                        <span class="av-icon cam-off-icon" id="cam-off-${letter}" style="display:none"><svg viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></span>
                    </div>
                `;
                // Click to offer seat switch (only visible to prod/host members)
                seatEl.addEventListener('click', (e) => {
                    if (!window.currentUser || !window.currentUser.seat) return;
                    const mySeat = window.currentUser.seat;
                    if (mySeat === letter) return; // can't switch with yourself
                    // Only show switch option between prod/host seats
                    if (!['A','B','C','D','E','F','G','H','I','J'].includes(String(mySeat))) return;
                    _showSeatSwitchMenu(letter, e.clientX, e.clientY);
                });
                document.body.appendChild(seatEl);
                // AV controls for our own new seat
                if (window.currentUser && window.currentUser.seat === letter) {
                    setTimeout(() => {
                        if (typeof window.setupAVControls === 'function') window.setupAVControls(letter);
                    }, 200);
                }
            } else {
                // Update name in existing seat
                const nameEl = document.getElementById('name-' + letter);
                if (nameEl) nameEl.textContent = _getDisplayName(letter, p.name || letter);
            }

            // Position the seat
            seatEl.style.position  = 'fixed';
            seatEl.style.left      = x + 'px';
            seatEl.style.top       = y + 'px';
            seatEl.style.width     = size + 'px';
            seatEl.style.height    = size + 'px';
            seatEl.style.transform = 'translate(-50%, -50%)';

            // Scale name label font size with seat size
            const _nameFontSize  = Math.max(0.7,  1.5 * _scale).toFixed(2);
            const _pronFontSize  = Math.max(0.6,  0.8 * _scale).toFixed(2);
            const _nameEl2 = seatEl.querySelector('.player-name');
            const _pronEl2 = seatEl.querySelector('.player-pronouns');
            if (_nameEl2) _nameEl2.style.fontSize = _nameFontSize + 'rem';
            if (_pronEl2) _pronEl2.style.fontSize = _pronFontSize + 'rem';

        });

        // Trigger AV icon update
        if (window._avIconsListener) {
            // Force re-evaluation by the existing listener
        }
    });
}


// ── Seat Switch System ─────────────────────────────────────────────────────
// Production members can swap seats with each other. A switch menu appears
// when clicking another prod/host seat. Target gets a confirmation modal.

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
        // Store swap state globally — persists until a new swap or game reset
        window._activeDisplaySwap = { seatA: sw.seatA, seatB: sw.seatB,
            nameA: sw.nameA, nameB: sw.nameB };
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
    // Visual-only swap: names and video feeds swap between two circles.
    // Firebase player records (seat field, isProdMember, role) are NOT changed.
    // This avoids conflicts between the host system and prod seat system.
    console.log('🔄 Executing visual seat swap:', seatA, '↔', seatB);

    // Read both players' info from Firebase to get names and identities
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

        // Write a display-only swap record — all tabs will read this and swap their DOM
        database.ref('game/displaySwap').set({
            seatA: seatA,
            seatB: seatB,
            nameA: playerA.name || seatA,
            nameB: playerB.name || seatB,
            identityA: playerA.name, // LiveKit identity = player name
            identityB: playerB.name,
            swappedAt: Date.now()
        });
        console.log('🔄 Display swap written to Firebase');
    });
}

// Helper: get the display name for a seat, respecting any active visual swap
function _getDisplayName(seat, originalName) {
    const sw = window._activeDisplaySwap;
    if (!sw) return originalName;
    if (String(seat) === String(sw.seatA)) return sw.nameB; // seatA now shows nameB
    if (String(seat) === String(sw.seatB)) return sw.nameA; // seatB now shows nameA
    return originalName;
}


// Apply a visual seat swap on this page — swaps names and video feeds
function _applyDisplaySwap(seatA, seatB, nameA, nameB, identityA, identityB) {
    console.log('🔄 Applying visual swap:', seatA, '↔', seatB);

    // Swap name labels
    const nameElA = document.getElementById('name-' + seatA);
    const nameElB = document.getElementById('name-' + seatB);
    if (nameElA) nameElA.textContent = nameB; // seat A now shows name B
    if (nameElB) nameElB.textContent = nameA; // seat B now shows name A

    // Swap video feeds: remove existing videos and re-attach to swapped positions
    const room = window._lkRoom;
    if (room) {
        // Handle local participant
        const localIdentity = room.localParticipant && room.localParticipant.identity;
        const myNewSeat = (localIdentity === identityA) ? seatB
                        : (localIdentity === identityB) ? seatA
                        : null;

        // Re-attach all prod/host seat videos to swapped positions
        const allParticipants = [...(room.remoteParticipants ? room.remoteParticipants.values() : [])];
        if (room.localParticipant) allParticipants.push(room.localParticipant);

        allParticipants.forEach((participant) => {
            const identity = participant.identity;
            let targetSeat = null;
            if (identity === identityA) targetSeat = seatB; // was in A, now shows in B
            else if (identity === identityB) targetSeat = seatA; // was in B, now shows in A
            if (!targetSeat) return;

            // Find and move existing video element
            const oldVideoA = document.getElementById('video-' + seatA);
            const oldVideoB = document.getElementById('video-' + seatB);
            const vidA = oldVideoA && oldVideoA.querySelector('.lk-video');
            const vidB = oldVideoB && oldVideoB.querySelector('.lk-video');

            // Detach both first, then re-attach to swapped positions
            if (vidA) { vidA.remove(); }
            if (vidB) { vidB.remove(); }

            // Re-attach using tracks
            participant.trackPublications.forEach((pub) => {
                if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                    setTimeout(() => _lkAttachVideo(pub.track, targetSeat, true, 0, participant === room.localParticipant), 100);
                }
                // For local participant, use localParticipant.videoTrack
                if (participant === room.localParticipant && pub.kind === 'video' && pub.track) {
                    setTimeout(() => _lkAttachVideo(pub.track, targetSeat, true, 0, true), 100);
                }
            });
        });

        // Update our own seat tracking if we're one of the swapped people
        const myS = window.currentUser && window.currentUser.seat;
        if (String(myS) === String(seatA)) {
            window.currentUser.seat = seatB;
            sessionStorage.setItem('playerSeat', String(seatB));
        } else if (String(myS) === String(seatB)) {
            window.currentUser.seat = seatA;
            sessionStorage.setItem('playerSeat', String(seatA));
        }
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
    return new Promise((resolve) => {
        database.ref('players')
            .orderByChild('name')
            .equalTo(identity)
            .once('value', (snap) => {
                let seat = null;
                snap.forEach((child) => {
                    const p = child.val();
                    // For main room: use main seat number
                    // For other rooms: use roomSeat ONLY — never fall back to
                    // main seat number since room-video-N uses room seat numbers (1-5)
                    seat = isMainRoom ? (p.seat || null) : (p.roomSeat || null);
                });
                if (!seat && attempt < 8) {
                    // Seat not assigned yet (player hasn't claimed one) — retry
                    // Up to 8 times × 500ms = 4 seconds
                    setTimeout(() => {
                        _lkIdentityToSeat(identity, isMainRoom, attempt + 1).then(resolve);
                    }, 500);
                } else {
                    resolve(seat);
                }
            });
    });
}

// Attach a video track to a seat's video-N div
function _lkAttachVideo(track, seatNumber, isMainRoom, attempt, isLocal) {
    attempt = attempt || 0; isLocal = !!isLocal;
    const divId = isMainRoom ? `video-${seatNumber}` : `room-video-${seatNumber}`;
    const container = document.getElementById(divId);
    if (!container) {
        if (!isMainRoom && attempt < 20) {
            // room-video-N not ready yet (overlay not open / seats not generated)
            // retry up to 20 times × 300ms = 6 seconds
            setTimeout(() => _lkAttachVideo(track, seatNumber, isMainRoom, attempt + 1), 300);
        } else {
            console.warn('📹 No container found for seat:', seatNumber, divId);
        }
        return;
    }

    // Remove any existing video element we put there
    const old = container.querySelector('.lk-video');
    if (old) old.remove();

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
    console.log('📹 Attached video to:', divId);
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
}

// ── Core: join a LiveKit room ─────────────────────────────────
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

    // Disconnect any existing room first
    await disconnectLiveKit();

    window._lkConnecting = true;
    window._lkGameRoom = gameRoom;
    const isMainRoom = (gameRoom === 'main');

    console.log('📹 Joining LiveKit room:', gameRoom, '| identity:', user.name);

    try {
        // 1. Fetch a signed token from the Cloud Function
        const tokenUrl = `${LIVEKIT_TOKEN_URL}?room=${encodeURIComponent(gameRoom)}&identity=${encodeURIComponent(user.name)}`;
        console.log('📹 Fetching token from:', tokenUrl);
        const resp = await fetch(tokenUrl);
        if (!resp.ok) {
            const errText = await resp.text().catch(() => 'no body');
            throw new Error(`Token fetch failed: ${resp.status} — ${errText}`);
        }
        const data = await resp.json();
        console.log('📹 Token received for room:', data.room);
        const token = data.token;

        // 2. Create Room and set up event listeners BEFORE connecting
        const room = new LivekitClient.Room({
            adaptiveStream:    true,  // auto quality based on network
            dynacast:          true,  // only send video to participants who need it
            videoCaptureDefaults: {
                resolution: LivekitClient.VideoPresets.h360.resolution,
            },
        });

        window._lkRoom = room;

        // ── Remote participant joined ──────────────────────────
        room.on(LivekitClient.RoomEvent.ParticipantConnected, async (participant) => {
            console.log('📹 Participant connected:', participant.identity);
            const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
            if (!seat) return;

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
                    _lkAttachVideo(track, seat, isMainRoom);
                }
            });

            // Handle tracks already published before we subscribed
            participant.trackPublications.forEach((pub) => {
                if (pub.track && pub.kind === LivekitClient.Track.Kind.Video) {
                    _lkAttachVideo(pub.track, seat, isMainRoom);
                }
            });
        });

        // ── Remote participant left ────────────────────────────
        room.on(LivekitClient.RoomEvent.ParticipantDisconnected, async (participant) => {
            console.log('📹 Participant disconnected:', participant.identity);
            const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
            if (seat) _lkDetachSeat(seat, isMainRoom);
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
            if (seat) _lkAttachVideo(track, seat, isMainRoom);
        });

        // ── Track unsubscribed ─────────────────────────────────
        room.on(LivekitClient.RoomEvent.TrackUnsubscribed, async (_track, _pub, participant) => {
            const seat = await _lkIdentityToSeat(participant.identity, isMainRoom);
            if (seat) _lkDetachSeat(seat, isMainRoom);
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
        const tracks = await LivekitClient.createLocalTracks({
            audio: true,
            video: {
                resolution: LivekitClient.VideoPresets.h360.resolution,
                facingMode: 'user',
            },
        });

        window._lkLocalTracks = tracks;
        // LiveKit JS SDK uses publishTrack (singular) per track
        for (const track of tracks) {
            await room.localParticipant.publishTrack(track);
        }
        console.log('✅ Local tracks published:', tracks.length, 'tracks');

        // 7. Watch for participants claiming seats AFTER we're already connected
        // This fires when a remote player's seat field is written to Firebase
        // (they were already in LiveKit but had no seat when step 6 ran)
        if (window._lkSeatWatcher) {
            database.ref('players').off('value', window._lkSeatWatcher);
        }
        // Debounce the seat watcher — rapid Firebase fires are batched into one scan
        let _seatWatcherTimer = null;
        window._lkSeatWatcher = database.ref('players').on('value', () => {
            if (_seatWatcherTimer) return; // already queued
            _seatWatcherTimer = setTimeout(() => {
                _seatWatcherTimer = null;
                // Re-scan all remote participants to find any who now have a seat
                // but haven't had their video attached yet
                room.remoteParticipants.forEach(async (participant) => {
                    const seat = await _lkIdentityToSeat(participant.identity, isMainRoom, 0);
                    if (!seat) return;
                    const divId = isMainRoom ? ('video-' + seat) : ('room-video-' + seat);
                    const container = document.getElementById(divId);
                    if (!container || container.querySelector('.lk-video')) return; // already attached
                    participant.trackPublications.forEach((pub) => {
                        if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                            _lkAttachVideo(pub.track, seat, isMainRoom, 0);
                            console.log('📹 Seat-watcher attached video for', participant.identity, '→', divId);
                        }
                    });
                });
            }, 2000); // 2s debounce — batch rapid Firebase changes
        });

        // For breakout rooms: scan already-connected participants and attach video
        // (they may have connected before us so their TrackSubscribed already fired)
        if (!isMainRoom) {
            setTimeout(() => {
                room.remoteParticipants.forEach(async (participant) => {
                    const seat = await _lkIdentityToSeat(participant.identity, false);
                    if (!seat) return;
                    participant.trackPublications.forEach((pub) => {
                        if (pub.kind === LivekitClient.Track.Kind.Video && pub.track && pub.isSubscribed) {
                            _lkAttachVideo(pub.track, seat, false, 0);
                            console.log('📹 Late-attach room video:', participant.identity, '→ room-video-' + seat);
                        }
                    });
                });
            }, 500);
        }

        // Restore mute state from Firebase so it carries across rooms
        if (user.id) {
            database.ref('players/' + user.id).once('value', (snap) => {
                const pData = snap.val() || {};
                if (pData.audioMuted) {
                    const micPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                    if (micPub && !micPub.isMuted) {
                        micPub.mute();
                        console.log('🎤 Restored muted state from Firebase');
                    }
                }
                if (pData.videoMuted) {
                    const camPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                    if (camPub && !camPub.isMuted) {
                        camPub.mute();
                        console.log('📹 Restored video-off state from Firebase');
                    }
                }
            });
        }

        // 5. Attach own video to own seat
        // For non-main rooms roomSeat may not be assigned yet — retry until it is
        const _attachOwnVideo = (attempt) => {
            attempt = attempt || 0;
            const u      = _lkCurrentUser();
            const mySeat = isMainRoom
                ? (u && u.seat)
                : (u && u.roomSeat);  // roomSeat only — main seat ≠ room seat
            console.log('🪑 _attachOwnVideo attempt — isMainRoom:', isMainRoom, '| seat:', u && u.seat, '| roomSeat:', u && u.roomSeat, '| mySeat:', mySeat);

            if (!mySeat) {
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
                            setTimeout(_attachOwnVideo, 500);
                        }
                    });
                } else {
                    if (attempt < 80) { // max 40s wait
                        setTimeout(() => _attachOwnVideo(attempt + 1), 500);
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
    console.log('🌙 Entering Night — disconnecting LiveKit (cameras off)');
    disconnectLiveKit();
};

window.exitNight = function() {
    console.log('🌙 Exiting Night phase');
    // Room re-join is handled by the room watcher below
};

// Called by PhaseManager when entering Breakfast phase
window.enterBreakfastPhase = function() {
    console.log('🍳 Entering Breakfast — disconnecting LiveKit (cameras off)');
    disconnectLiveKit();
};

window.exitBreakfast = function() {
    console.log('🍳 Exiting Breakfast phase');
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
            const blocked = (phase === 'night' || phase === 'breakfast');

            console.log('📹 Room changed to:', room, '| phase:', phase);

            if (!room || room === 'waiting' || blocked) {
                disconnectLiveKit();
                return;
            }

            // Only join if user has a name (fully registered)
            const u = _lkCurrentUser();
            const placeholderName = !u || !u.name || ['New Host', 'New Player'].includes(u.name);
            if (placeholderName) {
                // Name not set yet — wait a moment and retry
                setTimeout(() => joinLiveKitRoom(room), 1000);
                return;
            }

            joinLiveKitRoom(room);
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
function _positionAVControls(seatNumber) {
    const seat = document.getElementById('seat-' + seatNumber);
    const label = document.getElementById('seat-label-' + seatNumber);
    const controls = document.getElementById('av-controls-' + seatNumber);
    if (!seat || !label || !controls || controls.style.display === 'none') return;

    // Use getBoundingClientRect to find label bottom relative to seat top
    const seatRect  = seat.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const labelBottomRelative = (labelRect.bottom - seatRect.top);
    controls.style.top = (labelBottomRelative + 3) + 'px';
}

// Re-position all visible AV controls (called after resize)
function _repositionAllAVControls() {
    document.querySelectorAll('.seat-av-controls').forEach(el => {
        if (el.style.display !== 'none') {
            const id = el.id.replace('av-controls-', '');
            _positionAVControls(parseInt(id));
        }
    });
}

// ── AV Controls: show buttons on own seat, icons on all seats ─────────────────
window.setupAVControls = function(seatNumber) {
    console.log('🎛️ setupAVControls called for seat:', seatNumber, '| currentUser:', window.currentUser && window.currentUser.id);
    // Show control buttons only on our own seat
    const controls = document.getElementById('av-controls-' + seatNumber);
    if (controls) {
        controls.style.display = 'flex';
        setTimeout(() => _positionAVControls(seatNumber), 50);
    }

    // Only one global AV listener at a time — detach previous before adding
    if (window._avIconsListener) {
        database.ref('players').off('value', window._avIconsListener);
        window._avIconsListener = null;
    }

    window._avIconsListener = database.ref('players').on('value', (snap) => {
        // Incremental update — build desired state first, then apply atomically.
        // Avoids the reset-all → Firebase-read → redraw race condition.
        const myId     = window.currentUser && window.currentUser.id;
        const micState = {};   // seat → bool (muted)
        const camState = {};   // seat → bool (muted)
        const mySeats  = {};   // seat → bool (belongs to me)

        snap.forEach((child) => {
            const p = child.val();
            if (!p || !p.seat) return;
            const s = p.seat;
            micState[s] = !!p.audioMuted;
            camState[s] = !!p.videoMuted;
            // Main host: child.key='host'; prod members: child.key='prod-B' etc.
            const _isMainHost = window.currentUser && window.currentUser.role === 'host' && window.currentUser.id === 'host';
            const _meKey = _isMainHost ? 'host' : myId;
            if (child.key === _meKey || child.key === myId || p.id === myId) mySeats[s] = true;
            if (p.audioMuted || p.videoMuted) {
                console.log('🔔 AV icon — key:', child.key, 'seat:', s,
                    'audio:', !!p.audioMuted, 'video:', !!p.videoMuted,
                    'isMe:', !!(child.key === myId || p.id === myId));
            }
        });

        // Apply state to every seat that has DOM elements
        // Numeric seats (1-25) plus prod letter seats (B-J)
        const _allSeats = [];
        for (let s = 1; s <= 25; s++) _allSeats.push(s);
        ['B','C','D','E','F','G','H','I','J'].forEach(l => _allSeats.push(l));
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
    });
};

window.toggleMic = function() {
    const user = window.currentUser;
    if (!user) return;
    const room = window._lkRoom;
    if (!room) return;
    const micPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    if (!micPub) return;
    const nowMuted = micPub.isMuted;
    if (nowMuted) {
        micPub.unmute();
    } else {
        micPub.mute();
    }
    const newMuted = !nowMuted;
    // Host record is always at players/host regardless of currentUser.id
    // Main host uses 'host' path; prod members use their own id (prod-B etc)
    const _avPlayerId = (user.role === 'host' && user.id === 'host') ? 'host' : user.id;
    database.ref('players/' + _avPlayerId + '/audioMuted').set(newMuted);
    const seat = user.seat;
    const btn = document.getElementById('mic-btn-' + seat);
    if (btn) btn.classList.toggle('av-muted', newMuted);
    const icon = document.getElementById('mic-off-' + seat);
    if (icon) icon.style.display = newMuted ? 'flex' : 'none';
    console.log('🎤 Mic toggled:', newMuted ? 'muted' : 'unmuted');
};

window.toggleCam = function() {
    const user = window.currentUser;
    if (!user) return;
    const room = window._lkRoom;
    if (!room) return;
    const camPub = room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
    if (!camPub) return;
    const nowMuted = camPub.isMuted;
    if (nowMuted) {
        camPub.unmute();
    } else {
        camPub.mute();
    }
    const newMuted = !nowMuted;
    const _avPlayerIdCam = (user.role === 'host' && user.id === 'host') ? 'host' : user.id;
    database.ref('players/' + _avPlayerIdCam + '/videoMuted').set(newMuted);
    const seat = user.seat;
    const btn = document.getElementById('cam-btn-' + seat);
    if (btn) btn.classList.toggle('av-muted', newMuted);
    const icon = document.getElementById('cam-off-' + seat);
    if (icon) icon.style.display = newMuted ? 'flex' : 'none';
    // Hide/show the local video element
    const videoDiv = document.getElementById('video-' + seat);
    if (videoDiv) videoDiv.style.opacity = newMuted ? '0' : '1';
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
    t.innerHTML = `<span style="color:#4169E1">End: ${e}</span> &nbsp;|&nbsp; <span style="color:#DC143C">Banish: ${b}</span> &nbsp;|&nbsp; Locked: ${tot}`;

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
        database.ref('players/' + nid).once('value', (s) => {
            database.ref('game/phaseTitle').set((s.val()?.name || 'Next') + ' voted for...');
        });
    });
}

function listenEndGameBanishTally(voteKey, elId) {
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
            btn.style.display = 'none';
        }
    });
});

// Banishment reveal big text
['banishment', 'banishmentTie'].forEach((voteKey) => {
    database.ref('game/endGame/' + voteKey + '/revealedVotes').on('child_added', (snap) => {
        const data = snap.val();
        if (!data || Date.now() - (data.timestamp || 0) > 10000) return;

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
        if (!btn || btn.style.display !== 'block') return;
        btn.style.display = 'none';
        database.ref('game/endGame/smokeVote/votes/' + currentUser.id).once('value', (snap) => {
            const choice = snap.val();
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
        if (!btn || btn.style.display !== 'block') return;
        btn.style.display = 'none';
        const tryKey = (voteKey) => {
            database.ref('game/endGame/' + voteKey + '/currentRevealer').once('value', (crSnap) => {
                if (crSnap.val() !== currentUser.id) return;
                database.ref('game/endGame/' + voteKey + '/votes/' + currentUser.id).once('value', (vSnap) => {
                    const votedSeat = vSnap.val();
                    if (!votedSeat) return;
                    const seatNum = parseInt(votedSeat, 10);
                    database.ref('players').once('value', (pSnap) => {
                        const players      = pSnap.val() || {};
                        const targetPlayer = Object.values(players).find((p) => p.seat === seatNum);
                        const votedFor     = targetPlayer ? targetPlayer.name : ('Seat ' + seatNum);
                        database.ref('game/endGame/' + voteKey + '/revealedVotes/' + currentUser.id).set({
                            seat: currentUser.seat, name: currentUser.name, votedFor, timestamp: Date.now(),
                        });
                        database.ref('game/endGame/' + voteKey + '/alreadyRevealed/' + currentUser.id).set(true);
                    });
                });
            });
        };
        tryKey('banishment');
        tryKey('banishmentTie');
    };
});

// Winners listener
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
database.ref('game/phaseTitle').on('value', (snap) => {
    const t = snap.val();
    if (!t) return;
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
