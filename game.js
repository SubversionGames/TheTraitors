// Version: 2025-01-18 1:09 REBUILD
// ============================================
// GAME STATE MANAGEMENT
// ============================================

let gameState = {
    phase: 'waiting',
    players: {},
    seats: {},
    timer: null,
    voting: null,
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
                        updates[playerId + '/seat'] = 1;
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
                'voting': 'Voting Phase',
                'vote-reveal': 'Vote Reveal',
                'circle-of-truth': 'Circle of Truth',
                'night': 'Night'
            };
            phaseElement.textContent = phaseNames[phase] || phase;
        }
        
        // Force seats visible during lobby phase
        if (phase === 'lobby' && currentUser.role === 'player' && currentUser.room === 'main') {
            setTimeout(() => {
                document.querySelectorAll('.video-seat').forEach(seat => {
                    seat.style.display = 'flex';
                    seat.style.visibility = 'visible';
                });
            }, 100);
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
            if (phaseEl) phaseEl.style.display = '';
            if (timerEl && phase !== 'night' && phase !== 'breakfast') timerEl.style.display = '';
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
                'voting': 'Voting Phase',
                'vote-reveal': 'Vote Reveal',
                'circle-of-truth': 'Circle of Truth',
                'night': 'Night'
            };
            
            // NO TIMER DATA: Hide timer and update phase display
            if (!timer || !timer.totalSeconds) {
                console.log('🚫 No timer data - HIDING timer');
                timerElement.style.display = 'none';
                timerElement.style.visibility = 'hidden'; // Also hide visibility!
                phaseElement.textContent = phaseNames[currentPhase] || currentPhase;
                phaseElement.style.display = 'block';
                return;
            }
            
            // TIMER EXISTS: Show it
            console.log('✨ Timer exists - SHOWING timer');
            timerElement.style.display = 'block';
            timerElement.style.visibility = 'visible'; // Also set visibility!
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
                                database.ref('game/voting/votingLocked').set(true);
                                
                                // Show voting ended animation
                                database.ref('game/votingEndedAnimation').set(true);
                                setTimeout(() => {
                                    database.ref('game/votingEndedAnimation').remove();
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
    
    // Listen to player changes
    database.ref('players').on('value', (snapshot) => {
        const players = snapshot.val() || {};
        gameState.players = players;
        updatePlayerDisplay();
    });
    
    // Listen to voting changes
    database.ref('game/voting').on('value', (snapshot) => {
        const voting = snapshot.val();
        if (voting) {
            gameState.voting = voting;
            handleVotingUpdate(voting);
            
            // Enable voting for players when voting starts (only once)
            if (voting.active && !voting.votingLocked && currentUser.role === 'player') {
                if (!window.votingAlreadyEnabled) {
                    console.log('🗳️ Voting is active - enabling seat clicks');
                    enableVoting();
                    window.votingAlreadyEnabled = true;
                }
            }

            // Reset voting enabled flag when voting ends
            if (!voting.active && window.votingAlreadyEnabled) {
                window.votingAlreadyEnabled = false;
                console.log('🗳️ Voting ended - resetting flag');
            }
        }
    });

    // Clear vote tallies when phase changes away from voting/reveal
    database.ref('game/phase').on('value', (snapshot) => {
        const phase = snapshot.val();
        
        // Clear vote displays if not in voting or vote-reveal phase
        if (phase !== 'voting' && phase !== 'vote-reveal') {
            // Clear all vote tally sections
            const sections = ['original-count', 'reveal-count', 'revote-total', 'revote-reveal-count'];
            sections.forEach(sectionId => {
                const element = document.getElementById(sectionId);
                if (element) {
                    element.innerHTML = '<div style="color: #666;">No votes cast yet</div>';
                }
            });
            
            // Hide revote sections
            const revoteSection = document.getElementById('revote-section');
            const revoteRevealSection = document.getElementById('revote-reveal-section');
            if (revoteSection) revoteSection.style.display = 'none';
            if (revoteRevealSection) revoteRevealSection.style.display = 'none';
        }
    }); 

    // Highlight current revealer's seat with yellow glow
    database.ref('game/voting/currentRevealer').on('value', (snapshot) => {
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
    
    // Listen to Circle of Truth
    database.ref('game/circleOfTruth').on('value', (snapshot) => {
        console.log('🎯 Circle of Truth listener fired. Data:', snapshot.val());
        const circle = snapshot.val();
        
        if (circle && circle.active) {
            console.log('🎯 Circle is ACTIVE - Processing for user role:', currentUser.role);
            console.log('🎯 Calling handleCircleOfTruth for player:', circle.playerId);
            
            // Hide phase title during Circle of Truth
            const phaseElement = document.getElementById('phase-name');
            if (phaseElement) {
                phaseElement.style.display = 'none';
                console.log('✅ Phase title hidden');
            }
            
            // Call handler for ALL users (host and players)
            handleCircleOfTruth(circle.playerId);
            
        } else {
            console.log('❌ Circle data invalid or not active');
            
            // Reset any enlarged seats
            document.querySelectorAll('.video-seat').forEach(seat => {
                seat.style.transform = '';
                seat.style.zIndex = '';
            });
            
            // Show phase title again
            const phaseElement = document.getElementById('phase-name');
            if (phaseElement) {
                phaseElement.style.display = 'block';
                console.log('✅ Phase title shown');
            }
        }
    });

    // Preserve vote displays during window resize
    window.addEventListener('resize', () => {
        // Store current vote displays before resize
        const voteDisplays = {};
        for (let i = 1; i <= 25; i++) {
            const nameElement = document.getElementById(`name-${i}`);
            if (nameElement && nameElement.dataset.showingVote) {
                voteDisplays[i] = {
                    votedFor: nameElement.textContent,
                    showing: true
                };
            }
        }
        
        // Restore vote displays after resize completes
        setTimeout(() => {
            for (let seat in voteDisplays) {
                const nameElement = document.getElementById(`name-${seat}`);
                const pronounsElement = document.getElementById(`pronouns-${seat}`);
                const seatLabel = nameElement ? nameElement.parentElement : null;
                
                if (nameElement && seatLabel && voteDisplays[seat].showing) {
                    nameElement.dataset.showingVote = 'true';
                    pronounsElement.dataset.showingVote = 'true';
                    seatLabel.dataset.showingVote = 'true';
                    
                    seatLabel.style.background = '#B2BEB5';
                    pronounsElement.textContent = '';
                    pronounsElement.style.visibility = 'hidden';
                    nameElement.textContent = voteDisplays[seat].votedFor;
                    nameElement.style.fontFamily = "'ShootingStar', cursive";
                    nameElement.style.color = '#fff';
                    nameElement.style.fontSize = '1.3rem';
                }
            }
        }, 100);
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
                'voting': 'Voting Phase',
                'vote-reveal': 'Vote Reveal',
                'circle-of-truth': 'Circle of Truth',
                'night': 'Night'
            };
            phaseElement.textContent = phaseNames[phase] || phase;
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
            if (currentUser.role === 'player' && currentUser.room !== 'waiting') {
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
    // Check if player is in turret (invited traitors)
    if (currentUser.role === 'player') {
        database.ref('players/' + currentUser.id + '/room').once('value', (snapshot) => {
            const room = snapshot.val();
            if (room !== 'turret') {
                // Show "The Traitors Are Meeting In The Turret..." screen
                const overlay = document.getElementById('night-overlay') || createNightOverlay();
                overlay.classList.add('visible');
            }
        });
    }
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
    for (let i = 2; i <= 25; i++) {
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
            
            let seatNumber = 2; // Start at seat 2 (seat 1 is Host)
            
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
            <div class="seat-label">
                <span class="player-name" id="name-${seat.number}">Empty</span>
                <span class="player-pronouns" id="pronouns-${seat.number}"></span>
            </div>
            <div class="seat-controls" id="controls-${seat.number}" style="display: none;">
                <button class="seat-control-btn" id="mic-${seat.number}" onclick="toggleMic(${seat.number})" title="Toggle Microphone">
                    🎤
                </button>
                <button class="seat-control-btn" id="video-${seat.number}-btn" onclick="toggleVideo(${seat.number})" title="Toggle Video">
                    📹
                </button>
            </div>
            ${currentUser.role === 'host' ? `
            <button class="seat-remove-btn" id="remove-${seat.number}" onclick="removeSeatVisually(${seat.number})" title="Remove this seat" style="display: none;">
                ✕
            </button>
            ` : ''}
            <div class="vote-indicator" id="vote-${seat.number}"></div>
        `;
        
        seatElement.addEventListener('click', (e) => {
            // Check if in vote reveal selection mode (host only)
            if (window.voteRevealSelectionMode && currentUser.role === 'host') {
                window.selectSeatForReveal(seat.number);
                return;
            }
            // Don't trigger if clicking controls, labels, or remove buttons
            if (e.target.closest('.seat-controls') || 
                e.target.closest('.seat-label') || 
                e.target.closest('.seat-remove-btn') ||
                e.target.closest('.vote-indicator')) {
                return;
            }
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
                
                // Name tag
                const nameTag = document.createElement('div');
                nameTag.className = 'name-tag';
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
        }
    }

    // Hide room overlay (return to main roundtable) (GLOBAL for player.html access)
    window.hideRoomOverlay = function() {
        const overlay = document.getElementById('room-overlay');
        if (overlay) {
            overlay.style.display = 'none';
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
    
    const hostSeat = document.getElementById('seat-1');
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
        const currentTotalSeats = document.querySelectorAll('.video-seat').length - 1; // -1 for host
        
        if (newCount < currentTotalSeats) {
            // We're removing seats
            for (let i = newCount + 2; i <= currentTotalSeats + 1; i++) { // +1 because seat 1 is host
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
            database.ref('game/voting/active').once('value'),
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

            // Update global window reference for Agora
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
            }

            // Enable video/audio when seat is claimed (ready for Agora)
            if (window.agoraClient) {
                console.log('📹 Enabling video/audio for seat:', seatNumber);
                // This will be implemented when Agora is re-enabled
                // window.agoraClient.publish().then(() => {
                //     console.log('✅ Video/audio published');
                // });
            }
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
        for (let i = 1; i <= 25; i++) {
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

                // Only update if not showing vote
                if (!nameElement.dataset.showingVote) {
                    nameElement.textContent = playerInSeat.name;
                    nameElement.style.cssText = ''; // Reset styling
                }
                if (pronounsElement && !pronounsElement.dataset.showingVote) {
                    pronounsElement.textContent = playerInSeat.pronouns || '';
                    pronounsElement.style.cssText = ''; // Reset styling
                }
                if (seatLabel && !seatLabel.dataset.showingVote) {
                    seatLabel.style.cssText = ''; // Reset background
                }
                
                // Update pronouns display
                if (pronounsElement) {
                    if (playerInSeat.pronouns) {
                        pronounsElement.textContent = playerInSeat.pronouns;
                        pronounsElement.style.opacity = '0.7';
                    } else {
                        pronounsElement.textContent = 'pronouns';
                        pronounsElement.style.opacity = '0.4';
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
                nameElement.textContent = i === 1 ? 'Host' : 'Empty';
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
// VOTING SYSTEM
// ============================================

    function handleVotingUpdate(voting) {
        if (!voting.active) return;
        
        // Enable clicking on player names to vote (for players only)
        if (currentUser.role === 'player' && !voting.votingLocked) {
            enableVoting();
        }
        
        // Show vote tally (for host)
        if (currentUser.role === 'host') {
            updateVoteTally(voting.votes || {});
        }
        
        // Handle reveal phase
        if (voting.revealed) {
            handleVoteReveal(voting);
        }
    }

    function enableVoting() {
        // Check if this is a revote
        database.ref('game/voting/revote').once('value', (revoteSnap) => {
            const isRevote = revoteSnap.val();
            
            if (isRevote) {
                // Revote mode - only tied seats clickable
                database.ref('game/voting/tiedSeats').once('value', (seatsSnap) => {
                    const allowedSeats = seatsSnap.val() || [];
                    
                    for (let i = 2; i <= 25; i++) {
                        const seatElement = document.getElementById(`seat-${i}`);
                        if (!seatElement || seatElement.classList.contains('empty')) continue;
                        
                        if (allowedSeats.includes(i)) {
                            // Tied seat - clickable and highlighted
                            if (!seatElement.dataset.votingEnabled) {
                                seatElement.style.cursor = 'pointer';
                                seatElement.style.border = '3px solid #FFD700';
                                seatElement.style.boxShadow = '0 0 20px #FFD700';
                                seatElement.onclick = (e) => {
                                    if (e.target.closest('.seat-controls')) return;
                                    showVoteConfirmation(i);
                                };
                                seatElement.dataset.votingEnabled = 'true';
                            }
                        } else {
                            // Not tied - disabled
                            seatElement.style.cursor = 'not-allowed';
                            seatElement.style.opacity = '0.3';
                            seatElement.onclick = null;
                        }
                    }
                });
            } else {
                // Normal voting - all seats clickable
                for (let i = 2; i <= 25; i++) {
                    const seatElement = document.getElementById(`seat-${i}`);
                    if (!seatElement || seatElement.classList.contains('empty')) continue;
                    
                    if (!seatElement.dataset.votingEnabled) {
                        seatElement.style.cursor = 'pointer';
                        seatElement.onclick = (e) => {
                            if (e.target.closest('.seat-controls')) return;
                            showVoteConfirmation(i);
                        };
                        seatElement.dataset.votingEnabled = 'true';
                    }
                }
            }
        });
    }

    function showVoteConfirmation(seatNumber) {
        // Get player name
        const targetPlayer = Object.values(gameState.players).find(p => p.seat === seatNumber);
        const playerName = targetPlayer ? targetPlayer.name : `Seat ${seatNumber}`;
        
        // Check if we're in reveal phase - don't allow voting
        database.ref('game/voting/revealed').once('value', (revealSnap) => {
            if (revealSnap.val()) {
                alert('Voting has ended. You cannot change your vote during reveal.');
                return;
            }
            
            // Show confirmation modal
            if (typeof showConfirmation === 'function') {
                showConfirmation(
                    'Confirm Your Vote',
                    `You are about to lock in your vote for ${playerName}.`,
                    'Lock In',
                    () => {
                        castVote(seatNumber);
                    }
                );
            } else {
                // Fallback if showConfirmation doesn't exist
                if (confirm(`Lock in your vote for ${playerName}?`)) {
                    castVote(seatNumber);
                }
            }
        });
    }

    function castVote(seatNumber) {
        // Check if voting is still active
        database.ref('game/voting').once('value', (snapshot) => {
            const voting = snapshot.val();
            if (!voting || !voting.active || voting.votingLocked) {
                alert('Voting is closed.');
                return;
            }
            
            // Record vote in BOTH locations
            const voteUpdates = {};
            voteUpdates['game/voting/votes/' + currentUser.id] = seatNumber;
            
            // Check if this is the first vote (original) or a revote
            database.ref('game/voting/isRevote').once('value', (revoteSnap) => {
                const isRevote = revoteSnap.val() || false;
                
                // Always save original votes (never overwritten)
                if (!isRevote) {
                    voteUpdates['game/voting/originalVotes/' + currentUser.id] = seatNumber;
                }
                
                database.ref().update(voteUpdates).then(() => {
                    console.log('About to create vote overlay');
                    console.log('Vote recorded for player:', currentUser.id, 'voting for seat:', seatNumber);
                    console.log('Current user seat:', currentUser.seat);

                    // Show vote on name tag (for player and host) - INCLUDING SELF-VOTES
                    database.ref('players').once('value', (allPlayersSnap) => {
                        const targetPlayer = Object.values(allPlayersSnap.val() || {}).find(p => p.seat === seatNumber);
                        const targetName = targetPlayer ? targetPlayer.name : `Seat ${seatNumber}`;
                        
                        if (currentUser.role === 'player' && currentUser.seat) {
                            console.log('🎯 Showing vote on player name tag:', currentUser.seat, '→', targetName);
                            showVoteOnNameTag(currentUser.seat, targetName, true);
                        }
                    });
                    
                    // Visual feedback - modify name tag
                    if (currentUser.seat && (currentUser.role === 'player' || currentUser.role === 'host')) {
                        console.log('🎯 VOTE CAST - Modifying name tag');
                        
                        database.ref('game/voting/revealed').once('value', (revealedSnapshot) => {
                            if (revealedSnapshot.val()) {
                                console.log('❌ Reveal phase active - not showing vote');
                                return;
                            }
                            
                            // Find the target player's name
                            const targetPlayer = Object.values(gameState.players).find(p => p.seat === seatNumber);
                            const targetName = targetPlayer ? targetPlayer.name : `Seat ${seatNumber}`;
                            
                            // Store the vote display data
                            showVoteOnNameTag(currentUser.seat, targetName, currentUser.role === 'player');
                        });
                    } else {
                        console.error('❌ Cannot show overlay - seat:', currentUser.seat, 'role:', currentUser.role);
                    }
                });
            });
        });
    }

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
        
        // Name spot shows who they voted for
        nameElement.textContent = votedForName;
        nameElement.style.fontFamily = "'ShootingStar', cursive";
        nameElement.style.color = '#fff';
        nameElement.style.fontSize = '1.3rem';
        nameElement.style.textAlign = 'center';
        nameElement.style.display = 'block';
        
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
    // VOTE TALLY SYSTEM - COMPLETE REWRITE
    // ============================================
    
    // Listen for ORIGINAL votes (never cleared)
    database.ref('game/voting/originalVotes').on('value', (snapshot) => {
        const votes = snapshot.val();
        if (currentUser.role === 'host' && votes) {
            updateVoteTally(votes, 'original-count');
            
            // Show votes on name tags during voting phase only
            database.ref('game/phase').once('value', (phaseSnap) => {
                if (phaseSnap.val() === 'voting') {
                    database.ref('game/voting/revealed').once('value', (revealedSnapshot) => {
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
    
    // Listen for CURRENT votes (used during revote)
    database.ref('game/voting/votes').on('value', (snapshot) => {
        const votes = snapshot.val();
        
        if (!votes) return;
        
        // Determine if this is a revote
        database.ref('game/voting/isRevote').once('value', (revoteSnapshot) => {
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
                    if (phaseSnap.val() === 'voting') {
                        database.ref('game/voting/revealed').once('value', (revealedSnapshot) => {
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

function handleVoteReveal(voting) {
    // Handle space bar press to reveal vote
    if (currentUser.role === 'player') {
        const isMyTurn = voting.currentRevealer === currentUser.id;
        
        if (isMyTurn) {
            // Allow space bar to reveal
            document.addEventListener('keydown', handleRevealKeyPress);
        }
    }
}

function handleRevealKeyPress(e) {
    if (e.code === 'Space') {
        e.preventDefault();
        revealMyVote();
    }
}

function revealMyVote() {
    database.ref('game/voting/votes/' + currentUser.id).once('value', (snapshot) => {
        const votedFor = snapshot.val();
        if (!votedFor) return;
        
        // Mark as revealed
        database.ref('game/voting/revealed/' + currentUser.id).set(true);
        
        // Show vote to everyone
        const voteIndicator = document.getElementById(`vote-${currentUser.seat}`);
        if (voteIndicator) {
            voteIndicator.classList.add('visible');
        }
        
        // Move to next player (host will handle this)
        database.ref('game/voting/lastRevealed').set(currentUser.id);
        
        // Remove event listener
        document.removeEventListener('keydown', handleRevealKeyPress);
    });
}

// Listen for revealed votes during reveal phase
database.ref('game/revealedVoteDisplay').on('child_added', (snapshot) => {
    const data = snapshot.val();
    if (data && data.seat && data.votedFor) {
        showVoteOnNameTag(data.seat, data.votedFor, false);
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

// ============================================
// CIRCLE OF TRUTH
// ============================================

function handleCircleOfTruth(playerId) {
    console.log('🎯 handleCircleOfTruth called for playerId:', playerId);
    console.log('🎯 Current gameState.players:', gameState.players);
    
    const player = gameState.players[playerId];
    
    // Check if player exists
    if (!player || !player.seat) {
        console.error('❌ Player not found in gameState or has no seat:', playerId);
        return;
    }
    
    console.log('🎯 Found player:', player);
    console.log('🎯 Player seat:', player.seat);
    
    const seatElement = document.getElementById(`seat-${player.seat}`);
    
    if (seatElement) {
        console.log('✅ Found seat element, enlarging it for Circle of Truth');
        
        // Enlarge the seat (2x size) - works for both host and player
        seatElement.style.transition = 'transform 0.5s ease, z-index 0s';
        seatElement.style.transform = 'scale(2)';
        seatElement.style.zIndex = '1000';
        
        // Reset all other seats to normal size
        document.querySelectorAll('.video-seat').forEach(seat => {
            if (seat.id !== `seat-${player.seat}`) {
                seat.style.transform = 'scale(1)';
                seat.style.zIndex = '';
            }
        });
        
        // Counter-scale the seat label so it stays normal size
        const seatLabel = seatElement.querySelector('.seat-label');
        if (seatLabel) {
            seatLabel.style.transform = 'scale(0.5)';
            seatLabel.style.transformOrigin = 'center';
        }
        
        console.log('✅ Circle of Truth transform applied to seat', player.seat);
    } else {
        console.error('❌ Seat element not found for seat:', player.seat);
    }
}

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
            generateVideoSeats(); // Regenerate with new dimensions
            
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
            if (overlay && overlay.style.display === 'block' && window.currentUser && window.currentUser.room !== 'main') {
                database.ref('game/roomLimits/' + window.currentUser.room).once('value', (snap) => {
                    const limit = snap.val() || 5;
                    generateRoomSeats(window.currentUser.room, limit);
                });
            }
        }, 250); // Debounce for 250ms
    });
});

// Make rename available globally
window.renameSelf = renameSelf;

// Toggle microphone for a seat
function toggleMic(seatNumber) {
    // Only allow controlling own seat
    if (currentUser.seat !== seatNumber) {
        return;
    }
    
    const micBtn = document.getElementById(`mic-${seatNumber}`);
    
    // Toggle muted state
    const isMuted = micBtn.classList.contains('muted');
    
    if (isMuted) {
        micBtn.classList.remove('muted');
        console.log('Microphone ON for seat', seatNumber);
        
        // Update Firebase to track mute status
        database.ref('players/' + currentUser.id + '/audioMuted').set(false);
        
        // Unmute Agora audio
        if (typeof agoraManager !== 'undefined' && agoraManager.localAudioTrack) {
            agoraManager.localAudioTrack.setEnabled(true);
        }
    } else {
        micBtn.classList.add('muted');
        console.log('Microphone OFF for seat', seatNumber);
        
        // Update Firebase to track mute status IMMEDIATELY
        database.ref('players/' + currentUser.id + '/audioMuted').set(true).then(() => {
            console.log('✅ Mute status updated in Firebase');
        });
        
        // Mute Agora audio
        if (typeof agoraManager !== 'undefined' && agoraManager.localAudioTrack) {
            agoraManager.localAudioTrack.setEnabled(false);
        }
    }
}

// Optimized mute icon updates with minimal delay
let muteIconUpdateTimeout = null;

database.ref('game/muteAllPlayers').on('value', () => {
    clearTimeout(muteIconUpdateTimeout);
    muteIconUpdateTimeout = setTimeout(updateMuteIcons, 100); // Debounce 100ms
});

database.ref('players').on('child_changed', (snapshot) => {
    const player = snapshot.val();
    
    // Update mute icon
    if (player.audioMuted !== undefined) {
        updateSingleMuteIcon(player.seat, player.audioMuted);
    }
    
    // Update seat label if name or pronouns changed
    if (player.seat && (player.name || player.pronouns !== undefined)) {
        const nameLabel = document.getElementById('name-' + player.seat);
        const pronounsLabel = document.getElementById('pronouns-' + player.seat);
        
        if (nameLabel && player.name) {
            nameLabel.textContent = player.name;
        }
        if (pronounsLabel && player.pronouns !== undefined) {
            pronounsLabel.textContent = player.pronouns;
        }
    }
});

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

// Toggle video for a seat
function toggleVideo(seatNumber) {
    // Only allow controlling own seat
    if (currentUser.seat !== seatNumber) {
        return;
    }
    
    const videoBtn = document.getElementById(`video-${seatNumber}-btn`);
    
    // Toggle video-off state
    if (videoBtn.classList.contains('video-off')) {
        videoBtn.classList.remove('video-off');
        console.log('Video ON for seat', seatNumber);
        // TODO: Enable Agora video when re-enabled
    } else {
        videoBtn.classList.add('video-off');
        console.log('Video OFF for seat', seatNumber);
        // TODO: Disable Agora video when re-enabled
    }
}

// Listen for role reveals (show on all clients)
database.ref('game/roleReveal').on('value', (snapshot) => {
    const reveal = snapshot.val();
    if (!reveal) return;
    
    // Hide the phase name and timer
    const phaseEl = document.getElementById('phase-name');
    const timerEl = document.getElementById('timer');
    if (phaseEl) phaseEl.style.display = 'none';
    if (timerEl) timerEl.style.display = 'none';
    
    // Show role text in place of the phase name
    const roleColor = reveal.role === 'faithful' ? '#4169E1' : '#DC143C'; // blue or red
    const roleText = reveal.role === 'faithful' ? 'Faithful' : 'Traitor';
    
    // Create the role reveal text element
    const existing = document.getElementById('role-reveal-text');
    if (existing) existing.remove();
    
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
    
    // Fade in
    setTimeout(() => { roleEl.style.opacity = '1'; }, 10);
    
    // Auto-remove after 8 seconds, then restore phase name
    setTimeout(() => {
        roleEl.style.opacity = '0';
        setTimeout(() => {
            roleEl.remove();
            // Restore phase name with correct text
            if (phaseEl) {
                phaseEl.textContent = 'Circle of Truth';
                phaseEl.style.display = '';
            }
            // Timer stays hidden during circle-of-truth phase
        }, 500);
    }, 8000);
});

// Host sees all votes in real-time on name tags
if (currentUser && currentUser.role === 'host') {
    database.ref('game/voting/votes').on('value', (snapshot) => {
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
database.ref('game/voting/revote').on('value', (snapshot) => {
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
        database.ref('game/voting/currentRevealer').remove();
        
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