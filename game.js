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
    
    // Left border: aligned with profile text in top panel
    const leftBorderX = 20;
    
    // Right border: 20px to the right of expanded side panel
    // Panel structure: starts at 20px left, has 320px content + 40px tabs
    const panelLeft = 20;
    const panelContentWidth = 320;
    const panelTabWidth = 40;
    const panelRightEdge = panelLeft + panelContentWidth + panelTabWidth; // = 380px
    const rightBorderX = panelRightEdge + 20; // = 400px
    
    // Top border: below top panel
    const topBorderY = 90;
    
    // Bottom border: near bottom of viewport
    const bottomBorderY = viewportHeight - 50;
    
    // Calculate center of seating area
    const seatingAreaWidth = rightBorderX - leftBorderX; // 400 - 20 = 380px wide
    const seatingAreaHeight = bottomBorderY - topBorderY;
    
    const centerX = leftBorderX + (seatingAreaWidth / 2); // 20 + 190 = 210px
    const centerY = topBorderY + (seatingAreaHeight / 2);
    
    console.log(`Seating area: ${seatingAreaWidth}px wide x ${seatingAreaHeight}px tall`);
    console.log(`Boundaries: left=${leftBorderX}px, right=${rightBorderX}px, top=${topBorderY}px, bottom=${bottomBorderY}px`);
    console.log(`Center: x=${centerX}px, y=${centerY}px`);
    
    // ============================================
    // SEAT SIZING (% of seating area width)
    // ============================================
    
    // Player seats: proportion of available width
    const playerSeatSize = Math.min(seatingAreaWidth * 0.08, 180); // 8% of width, max 180px
    const hostSeatSize = playerSeatSize * 2; // Double player size
    
    // Enforce min sizes
    const finalPlayerSize = Math.max(playerSeatSize, 100);
    const finalHostSize = Math.max(hostSeatSize, 200);
    
    console.log(`Seat sizes: player=${finalPlayerSize}px, host=${finalHostSize}px`);
    
    // ============================================
    // CALCULATE POSITIONS (8-9-8 layout)
    // ============================================
    
    const seats = [];
    
    // MIDDLE ROW (9 seats total: 4 left + HOST + 4 right)
    const middleY = centerY;
    const middleRowSpacing = finalPlayerSize + 20; // 20px gap between seats
    
    // Left side of middle row (seats 10-13)
    for (let i = 0; i < 4; i++) {
        seats.push({
            number: 10 + i,
            x: centerX - (finalHostSize / 2) - middleRowSpacing * (4 - i),
            y: middleY,
            size: finalPlayerSize
        });
    }
    
    // Right side of middle row (seats 14-17)
    for (let i = 0; i < 4; i++) {
        seats.push({
            number: 14 + i,
            x: centerX + (finalHostSize / 2) + middleRowSpacing * (i + 1),
            y: middleY,
            size: finalPlayerSize
        });
    }
    
    // TOP ROW (8 seats: 2-9)
    const verticalGap = finalPlayerSize + 60; // 60px vertical gap
    const topY = centerY - verticalGap;
    
    // Calculate positions between middle row seats
    const topRowPositions = [];
    
    // Between left seats (10-11, 11-12, 12-13)
    for (let i = 0; i < 3; i++) {
        topRowPositions.push((seats[i].x + seats[i + 1].x) / 2);
    }
    
    // Between seat 13 and host
    topRowPositions.push((seats[3].x + centerX) / 2);
    
    // Between host and seat 14
    topRowPositions.push((centerX + seats[4].x) / 2);
    
    // Between right seats (14-15, 15-16, 16-17)
    for (let i = 4; i < 7; i++) {
        topRowPositions.push((seats[i].x + seats[i + 1].x) / 2);
    }
    
    for (let i = 0; i < 8; i++) {
        seats.push({
            number: 2 + i,
            x: topRowPositions[i],
            y: topY,
            size: finalPlayerSize
        });
    }
    
    // BOTTOM ROW (8 seats: 18-25)
    const bottomY = centerY + verticalGap;
    
    for (let i = 0; i < 8; i++) {
        seats.push({
            number: 18 + i,
            x: topRowPositions[i],
            y: bottomY,
            size: finalPlayerSize
        });
    }
    
    // ============================================
    // CREATE SEAT ELEMENTS (same as before)
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
        
        const labelStyle = 'position: absolute; top: calc(100% + 5px); left: 50%; transform: translateX(-50%); white-space: nowrap;';
        
        seatElement.innerHTML = `
            <div id="video-${seat.number}"></div>
            <div class="seat-label" style="${labelStyle}">
                <span class="player-name" id="name-${seat.number}" style="cursor: pointer; font-weight: bold; font-size: 0.9rem;">Empty</span>
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
    
    setTimeout(() => attachRenameHandlers(), 100);
}

function handleSeatClick(seatNumber) {
    // Only players in lobby phase can select seats
    if (currentUser.role !== 'player') return;
    if (gameState.phase !== 'lobby') return;
    
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
    const name = prompt('Enter your display name (max 12 characters):');
    if (!name || name.trim().length === 0) {
        return;
    }
    
    const trimmedName = name.trim().substring(0, 12);
    
    // Check for duplicate names
    database.ref('players').once('value', (snapshot) => {
        let nameExists = false;
        snapshot.forEach((child) => {
            if (child.val().name === trimmedName) {
                nameExists = true;
            }
        });
        
        if (nameExists) {
            alert('This name is already taken. Please choose another.');
            showPlayerNameModal(seatNumber);
            return;
        }
        
        // Claim the seat
        claimSeat(seatNumber, trimmedName);
    });
}

function claimSeat(seatNumber, playerName) {
    const playerData = {
        id: currentUser.id,
        name: playerName,
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
    
    console.log('Claimed seat:', seatNumber, 'as', playerName);
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
            
            // Make clickable if it's the current user's seat
            if (currentUser.role === 'player' && playerInSeat.id === currentUser.id) {
                nameElement.classList.add('clickable-name');
                nameElement.style.cursor = 'pointer';
                nameElement.onclick = renameSelf;
            } else {
                nameElement.classList.remove('clickable-name');
                nameElement.style.cursor = 'default';
                nameElement.onclick = null;
            }
            
            // Update seat display for video/room status
            updateSeatDisplay(i, playerInSeat);
        } else {
            seatElement.classList.add('empty');
            seatElement.classList.remove('active');
            nameElement.textContent = i === 1 ? 'Host' : 'Empty';
            nameElement.onclick = null;
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
    if (currentUser.role !== 'player') return;
    
    const currentName = currentUser.name;
    const newName = prompt('Enter your new name:', currentName);
    
    if (newName && newName.trim().length > 0 && newName.trim().length <= 12) {
        const trimmedName = newName.trim();
        
        // Check for duplicate names
        database.ref('players').once('value', (snapshot) => {
            let nameExists = false;
            snapshot.forEach((child) => {
                if (child.val().name === trimmedName && child.key !== currentUser.id) {
                    nameExists = true;
                }
            });
            
            if (nameExists) {
                alert('This name is already taken. Please choose another.');
                return;
            }
            
            // Update name
            currentUser.name = trimmedName;
            sessionStorage.setItem('playerName', trimmedName);
            
            // Update in Firebase
            database.ref('players/' + currentUser.id + '/name').set(trimmedName);
        });
    } else if (newName !== null) {
        alert('Name must be 1-12 characters.');
    }
}

// Real-time resize handler
window.addEventListener('resize', () => {
    generateVideoSeats(); // Regenerate with new dimensions
});

// Make rename available globally
window.renameSelf = renameSelf;
