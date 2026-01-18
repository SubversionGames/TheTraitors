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
    role: null, // 'host', 'player', 'viewer', 'ghost'
    name: null,
    seat: null
};

// ============================================
// INITIALIZATION
// ============================================

function initializeGame() {
    // Set current user from sessionStorage
    currentUser.role = sessionStorage.getItem('userRole');
    currentUser.name = sessionStorage.getItem('playerName') || sessionStorage.getItem('viewerName');
    currentUser.id = sessionStorage.getItem('userId') || generateUserId();
    sessionStorage.setItem('userId', currentUser.id);
    
    // Listen to game state changes
    setupFirebaseListeners();
    
    // Initialize video seats
    generateVideoSeats();
    
    console.log('Game initialized for:', currentUser.role);
}

function generateUserId() {
    return currentUser.role + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// ============================================
// FIREBASE LISTENERS
// ============================================

function setupFirebaseListeners() {
    // Listen to game phase changes
    database.ref('game/phase').on('value', (snapshot) => {
        const phase = snapshot.val() || 'waiting';
        gameState.phase = phase;
        handlePhaseChange(phase);
    });
    
    // Listen to timer updates
    database.ref('game/timer').on('value', (snapshot) => {
        const timer = snapshot.val();
        if (timer) {
            gameState.timer = timer;
            updateTimerDisplay(timer);
            
            // Handle timer countdown
            if (timer.isRunning) {
                handleTimerTick();
            }
        }
    });
    
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
        }
    });
    
    // Listen to announcements
    database.ref('game/announcement').on('value', (snapshot) => {
        const announcement = snapshot.val();
        if (announcement) {
            showAnnouncement(announcement.text);
        }
    });
    
    // Listen to Circle of Truth
    database.ref('game/circleOfTruth').on('value', (snapshot) => {
        const circle = snapshot.val();
        if (circle && circle.active) {
            handleCircleOfTruth(circle.playerId);
        }
    });
}

// ============================================
// PHASE HANDLING
// ============================================

function handlePhaseChange(phase) {
    console.log('Phase changed to:', phase);
    
    // Update phase display
    const phaseDisplay = document.getElementById('phase-name');
    if (phaseDisplay) {
        const phaseNames = {
            'waiting': 'Waiting to Start',
            'lobby': 'Lobby - Select Your Seat',
            'breakfast': 'Breakfast',
            'talk': 'Talk Time',
            'deliberation': 'Deliberation',
            'night': 'Night'
        };
        phaseDisplay.textContent = phaseNames[phase] || phase;
    }
    
    // Handle night phase overlay
    if (phase === 'night') {
        showNightOverlay();
    } else {
        hideNightOverlay();
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
    } else if (currentUser.role === 'viewer') {
        // Viewers also see the night overlay
        const overlay = document.getElementById('night-overlay') || createNightOverlay();
        overlay.classList.add('visible');
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

function handleTimerTick() {
    // Only host should manage timer countdown
    if (currentUser.role !== 'host') return;
    
    // Clear existing interval
    if (timerInterval) {
        clearInterval(timerInterval);
    }
    
    timerInterval = setInterval(() => {
        database.ref('game/timer').once('value', (snapshot) => {
            const timer = snapshot.val();
            if (!timer || !timer.isRunning) {
                clearInterval(timerInterval);
                return;
            }
            
            if (timer.remainingSeconds > 0) {
                database.ref('game/timer/remainingSeconds').set(timer.remainingSeconds - 1);
            } else {
                // Timer expired
                clearInterval(timerInterval);
                database.ref('game/timer/isRunning').set(false);
                playGongSound();
                
                // If voting timer, lock votes
                database.ref('game/voting/active').once('value', (snapshot) => {
                    if (snapshot.val()) {
                        database.ref('game/voting/votingLocked').set(true);
                    }
                });
            }
        });
    }, 1000);
}

function playGongSound() {
    // Play audio cue when timer expires
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIGGS57OihUBELUKXh8LZjGwU5k9nzxnEpBS6Ayvragy8ID1us6vKpWBYNTKXj8rJcGAU7k9n0w3EmBzCBzvnajDYII2m57uyjUxQOTqXk87RfGgg8ldv0yHQrBzGCzvnZjjYKI2q67+ukVRgQUKvn9bVjGgg+mN30yXQrBzKCz/nZjjgKJGu87+ylVxkRUazo9bZlGwo/mtz1ynUrCDODz/rYjzkLJW++8O2mWRsTU6/p9rdoHAJBm972y3YrCTSE0PrZjzsLJW++8O2mWRsTVbDq97ZoHAJBm972y3YrCTSE0PrZjzwLJ2++8e6mWhsUVbDq97dpHAJCm972ynYrCTOE0PrZjzwLJ2++8u6mWhsUVbDq97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwUVbHr97dpHQNDnN/3ynYsCTOF0frZjz0MKG/A8u6mWhwU');
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
    // DEFINE PLAYER SEATING AREA BOUNDARIES
    // ============================================
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Calculate panel width (only needed for host positioning)
    const panelLeft = 20;
    const panelContentWidth = 320;
    const panelTabWidth = 40;
    const panelTotalWidth = panelLeft + panelContentWidth + panelTabWidth; // 380px
    
    // For player seats: use FULL viewport width (ignore panel)
    const leftBorderX = 50; // Small margin from left edge
    console.log('NEW CODE RUNNING - leftBorderX:', leftBorderX);
    const rightBorderX = viewportWidth - 50; // Small margin from right edge
    
    // Top border: near top of viewport
    const topBorderY = 20;
    
    // Bottom border: near bottom of viewport
    const bottomBorderY = viewportHeight - 50;
    
    // Calculate seating area dimensions (full width)
    const seatingAreaWidth = rightBorderX - leftBorderX;
    const seatingAreaHeight = bottomBorderY - topBorderY;
    
    // Calculate center - horizontal center of viewport
    const centerX = viewportWidth / 2;
    const centerY = topBorderY + (seatingAreaHeight / 2);
    
    console.log(`Viewport: ${viewportWidth}x${viewportHeight}`);
    console.log(`Seating area: ${seatingAreaWidth}px wide x ${seatingAreaHeight}px tall`);
    console.log(`Boundaries: left=${leftBorderX}px, right=${rightBorderX}px`);
    console.log(`Center: x=${centerX}px, y=${centerY}px`);
    
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
    
    const rows = 3;
    const cols = 8;
    
    // Calculate spacing based on FULL viewport width (not constrained seating area)
    const availableWidth = viewportWidth - 100; // 50px margin on each side
    const availableHeight = seatingAreaHeight - (finalPlayerSize * 1.5);
    
    const horizontalSpacing = (availableWidth - (cols * finalPlayerSize)) / (cols - 1); // Space BETWEEN seats only
    const verticalSpacing = (availableHeight - (rows * finalPlayerSize)) / (rows - 1); // Space BETWEEN seats only
    
    // Calculate total grid dimensions
    const totalGridWidth = (cols * finalPlayerSize) + ((cols - 1) * horizontalSpacing);
    const totalGridHeight = (rows * finalPlayerSize) + ((rows - 1) * verticalSpacing);
    
    // Center horizontally on viewport, keep vertical position
    const gridStartX = centerX - (totalGridWidth / 2);
    const gridStartY = topBorderY + (finalPlayerSize * 2) + verticalSpacing;
    
    console.log(`Creating 8x3 grid with spacing: H=${horizontalSpacing.toFixed(0)}px, V=${verticalSpacing.toFixed(0)}px`);
    
    let seatNumber = 2; // Start at seat 2 (seat 1 is Host)
    
    // Generate seats row by row
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = gridStartX + (col * (finalPlayerSize + horizontalSpacing));
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
    
    console.log(`Generated ${seats.length} player seats in 8x3 grid`);
    
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
            <div class="vote-indicator" id="vote-${seat.number}"></div>
        `;
        
        seatElement.addEventListener('click', () => handleSeatClick(seat.number));
        document.body.appendChild(seatElement);
    });
    
    console.log(`Generated 24 player seats in 8-9-8 layout`);
    
    // Store values for host positioning
    window.seatingCenterX = centerX;
    window.seatingCenterY = centerY;
    window.currentPlayerSize = finalPlayerSize;
    window.currentHostSize = finalHostSize;

    // ============================================
    // POSITION HOST SEAT IN TOP-LEFT
    // ============================================
    
    const hostSeat = document.getElementById('seat-1');
    if (hostSeat) {
        const hostX = 40;
        const hostY = 40;
        
        hostSeat.style.position = 'fixed';
        hostSeat.style.left = `${hostX}px`;
        hostSeat.style.top = `${hostY}px`;
        hostSeat.style.width = `${finalHostSize}px`;
        hostSeat.style.height = `${finalHostSize}px`;
        hostSeat.style.transform = 'none';
        
        console.log(`Host positioned at top-left: (${hostX}, ${hostY}) with size ${finalHostSize}px`);
    }
    
    // Re-attach rename handlers if function exists
    if (typeof attachRenameHandlers === 'function') {
        setTimeout(() => attachRenameHandlers(), 100);
    }
}
    
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
    // Only players in lobby phase can select seats
    if (currentUser.role !== 'player') return;
    
    // Check if seat is empty
    database.ref('game/seats/' + seatNumber).once('value', (snapshot) => {
        if (snapshot.val()) {
            alert('This seat is already taken. Please choose another.');
            return;
        }
        
        // Check if player already has a seat
        if (currentUser.seat) {
            alert('You already have a seat. Please refresh if you want to change seats.');
            return;
        }
        
        // Prompt for player name
        showPlayerNameModal(seatNumber);
    });
}

function showPlayerNameModal(seatNumber) {
    // Store the seat number globally so we can access it from the modal
    window.pendingSeatNumber = seatNumber;
    
    // Show the modal
    document.getElementById('name-pronouns-modal').classList.add('visible');
    
    // Clear previous values
    document.getElementById('modal-name-input').value = '';
    document.getElementById('modal-pronouns-input').value = '';
    document.getElementById('name-pronouns-error').style.display = 'none';
    
    // Focus on name input
    setTimeout(() => {
        document.getElementById('modal-name-input').focus();
    }, 100);
}

function closeNamePronounsModal() {
    document.getElementById('name-pronouns-modal').classList.remove('visible');
    window.pendingSeatNumber = null;
    window.editingNamePronouns = false;
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
        // Update in Firebase
        const userPath = currentUser.role === 'host' ? 'players/host' : 'players/' + currentUser.id;
        database.ref(userPath).update({
            name: trimmedName,
            pronouns: trimmedPronouns
        });
        
        // Update local state
        currentUser.name = trimmedName;
        sessionStorage.setItem('playerName', trimmedName);
        
        // Reset and close modal
        window.editingNamePronouns = false;
        closeNamePronounsModal();
        console.log('Updated name to:', trimmedName, 'and pronouns to:', trimmedPronouns);
        return;
    }
    
    // If claiming new seat
    closeNamePronounsModal();
    claimSeat(window.pendingSeatNumber, trimmedName, trimmedPronouns);
}

function claimSeat(seatNumber, playerName, pronouns) {
    const playerData = {
        id: currentUser.id,
        name: playerName,
        pronouns: pronouns || '', // Use provided pronouns or empty string
        seat: seatNumber,
        room: 'main',
        status: 'active',
        joinedAt: Date.now()
    };
    
    // Save to Firebase
    database.ref('players/' + currentUser.id).set(playerData);
    database.ref('game/seats/' + seatNumber).set(currentUser.id);
    
    // Update local state
    currentUser.name = playerName;
    currentUser.seat = seatNumber;
    sessionStorage.setItem('playerName', playerName);
    sessionStorage.setItem('playerSeat', seatNumber);
    
    console.log('Claimed seat:', seatNumber, 'as', playerName, 'with pronouns:', pronouns);
}

// ============================================
// PLAYER DISPLAY UPDATES
// ============================================

function updatePlayerDisplay() {
    for (let i = 1; i <= 25; i++) {
        const seatElement = document.getElementById(`seat-${i}`);
        const nameElement = document.getElementById(`name-${i}`);
        
        if (!seatElement || !nameElement) continue;
        
        let playerInSeat = null;
        for (let playerId in gameState.players) {
            const player = gameState.players[playerId];
            if (player.seat === i && player.status !== 'ghost') {
                playerInSeat = player;
                break;
            }
        }
        
        if (playerInSeat) {
            seatElement.classList.remove('empty');
            seatElement.classList.add('active');
            nameElement.textContent = playerInSeat.name;
            
            // Update pronouns display
            const pronounsElement = document.getElementById(`pronouns-${i}`);
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
            const seatLabel = nameElement.parentElement; // Get the seat-label div
            
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
                
                const pronounsElement = document.getElementById(`pronouns-${i}`);
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
            const pronounsElement = document.getElementById(`pronouns-${i}`);
            if (pronounsElement) {
                pronounsElement.textContent = '';
            }
            // Hide controls for empty seats
            const controls = document.getElementById(`controls-${i}`);
            if (controls) {
                controls.style.display = 'none';
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
    // Make player name tags clickable
    for (let i = 2; i <= 25; i++) {
        const nameElement = document.getElementById(`name-${i}`);
        if (nameElement && nameElement.textContent !== 'Empty') {
            nameElement.style.cursor = 'pointer';
            nameElement.onclick = () => castVote(i);
        }
    }
}

function castVote(seatNumber) {
    // Check if voting is still active
    database.ref('game/voting').once('value', (snapshot) => {
        const voting = snapshot.val();
        if (!voting || !voting.active || voting.votingLocked) {
            alert('Voting is closed.');
            return;
        }
        
        // Record vote
        database.ref('game/voting/votes/' + currentUser.id).set(seatNumber);
        
        // Visual feedback
        const voteIndicator = document.getElementById(`vote-${currentUser.seat}`);
        if (voteIndicator) {
            // Find player name in that seat
            const targetPlayer = Object.values(gameState.players).find(p => p.seat === seatNumber);
            voteIndicator.textContent = targetPlayer ? targetPlayer.name : `Seat ${seatNumber}`;
            voteIndicator.classList.add('visible');
        }
        
        alert(`You voted for Seat ${seatNumber}`);
    });
}

function updateVoteTally(votes) {
    const tallyElement = document.getElementById('vote-tally');
    const contentElement = document.getElementById('vote-tally-content');
    
    if (!tallyElement || !contentElement) return;
    
    // Count votes per seat
    const voteCounts = {};
    for (let voterId in votes) {
        const targetSeat = votes[voterId];
        voteCounts[targetSeat] = (voteCounts[targetSeat] || 0) + 1;
    }
    
    // Display tally
    contentElement.innerHTML = '';
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
    let colorIndex = 0;
    
    for (let seat in voteCounts) {
        const player = Object.values(gameState.players).find(p => p.seat === parseInt(seat));
        const name = player ? player.name : `Seat ${seat}`;
        const count = voteCounts[seat];
        const color = colors[colorIndex % colors.length];
        
        const item = document.createElement('div');
        item.className = 'vote-item';
        item.style.color = color;
        item.textContent = `${name} - ${count}`;
        contentElement.appendChild(item);
        
        colorIndex++;
    }
    
    tallyElement.classList.add('visible');
}

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

// ============================================
// CIRCLE OF TRUTH
// ============================================

function handleCircleOfTruth(playerId) {
    const player = gameState.players[playerId];
    if (!player) return;
    
    // Move player's video to center (visually)
    const seatElement = document.getElementById(`seat-${player.seat}`);
    if (seatElement) {
        seatElement.style.transform = 'translate(-50%, -50%) scale(1.5)';
        seatElement.style.zIndex = '1000';
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
window.addEventListener('resize', () => {
    generateVideoSeats(); // Regenerate with new dimensions
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
    if (micBtn.classList.contains('muted')) {
        micBtn.classList.remove('muted');
        console.log('Microphone ON for seat', seatNumber);
        // TODO: Unmute Agora audio when re-enabled
    } else {
        micBtn.classList.add('muted');
        console.log('Microphone OFF for seat', seatNumber);
        // TODO: Mute Agora audio when re-enabled
    }
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

// FORCE host to top-left - diagnostic
setTimeout(() => {
    const hostSeat = document.getElementById('seat-1');
    if (hostSeat) {
        hostSeat.style.left = '40px';
        hostSeat.style.top = '40px';
        hostSeat.style.transform = 'none';
        console.log('FORCED host position');
    }
}, 1000);
