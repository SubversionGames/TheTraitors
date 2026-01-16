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
    const circle = document.getElementById('video-circle');
    if (!circle) return;
    
    // ============================================
    // SPACING CONTROLS - ADJUST THESE VALUES
    // ============================================
    
    // Distance from edges
    const topMargin = 165;        
    const bottomMargin = 100;     
    const sideMargin = 200;       
    
    // Horizontal spread for top/bottom rows
    const horizontalPadding = 500; 
    const horizontalEndPadding = 300; 
    
    // Vertical gaps between corners and side seats
    const verticalGapFromCorner = 200; 
    
    // ============================================
    // CALCULATE DYNAMIC SEAT SIZE
    // ============================================
    
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Calculate available space
    const availableWidth = viewportWidth - horizontalPadding - horizontalEndPadding;
    const availableHeight = viewportHeight - topMargin - bottomMargin - (verticalGapFromCorner * 2);
    
    // Calculate max seat size based on spacing
    const topSeats = 8;
    const maxSeatWidthFromTop = availableWidth / topSeats * 0.8; // 80% of available space per seat
    
    const sideSeats = 4;
    const maxSeatHeightFromSide = availableHeight / sideSeats * 0.8;
    
    // Choose the smaller dimension to ensure all fits
    const calculatedSeatSize = Math.min(maxSeatWidthFromTop, maxSeatHeightFromSide, 180); // Max 180px
    const minSeatSize = 100; // Minimum 100px
    const seatSize = Math.max(minSeatSize, calculatedSeatSize);
    
    console.log(`Calculated seat size: ${seatSize}px (viewport: ${viewportWidth}x${viewportHeight})`);
    
    // ============================================
    // END OF SPACING CONTROLS
    // ============================================
    
    const seats = [];
    
    // TOP ROW - Spread across window width
    const topY = topMargin;
    const topStartX = horizontalPadding;
    const topEndX = viewportWidth - horizontalEndPadding;
    const topSpacing = (topEndX - topStartX) / (topSeats - 1);
    
    for (let i = 0; i < topSeats; i++) {
        seats.push({
            number: i + 2,
            x: topStartX + (topSpacing * i),
            y: topY,
            labelPosition: 'bottom'
        });
    }
    
    // RIGHT SIDE - Fixed distance from right edge
    const rightSeats = 4;
    const rightX = viewportWidth - sideMargin;
    const rightStartY = topY + verticalGapFromCorner;
    const rightEndY = (viewportHeight - bottomMargin) - verticalGapFromCorner;
    const rightSpacing = (rightEndY - rightStartY) / (rightSeats - 1);
    
    for (let i = 0; i < rightSeats; i++) {
        seats.push({
            number: 10 + i,
            x: rightX,
            y: rightStartY + (rightSpacing * i),
            labelPosition: 'left'
        });
    }
    
    // BOTTOM ROW - Mirror top row (right to left)
    const bottomSeats = 8;
    const bottomY = viewportHeight - bottomMargin;
    
    for (let i = 0; i < bottomSeats; i++) {
        seats.push({
            number: 14 + i,
            x: topEndX - (topSpacing * i),
            y: bottomY,
            labelPosition: 'top'
        });
    }
    
    // LEFT SIDE - Fixed distance from left edge
    const leftSeats = 4;
    const leftX = sideMargin;
    
    for (let i = 0; i < leftSeats; i++) {
        seats.push({
            number: 22 + i,
            x: leftX,
            y: rightEndY - (rightSpacing * i),
            labelPosition: 'right'
        });
    }
    
    // Create all seats with dynamic size
    seats.forEach(seat => {
        const seatElement = document.createElement('div');
        seatElement.className = 'video-seat empty';
        seatElement.id = `seat-${seat.number}`;
        seatElement.style.position = 'fixed';
        seatElement.style.left = `${seat.x}px`;
        seatElement.style.top = `${seat.y}px`;
        seatElement.style.width = `${seatSize}px`; // Dynamic size
        seatElement.style.height = `${seatSize}px`; // Dynamic size
        seatElement.style.transform = 'translate(-50%, -50%)';
        
        // Label positioning logic
        let labelStyle = 'position: absolute; white-space: nowrap;';
        switch(seat.labelPosition) {
            case 'bottom':
                labelStyle += 'top: calc(100% + 5px); left: 50%; transform: translateX(-50%);';
                break;
            case 'top':
                labelStyle += 'bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%);';
                break;
            case 'left':
                labelStyle += 'top: 50%; right: calc(100% + 5px); transform: translateY(-50%);';
                break;
            case 'right':
                labelStyle += 'top: 50%; left: calc(100% + 5px); transform: translateY(-50%);';
                break;
        }
        
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
    
    console.log('Generated 24 player seats with responsive positioning and sizing');
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

// Regenerate seats on window resize
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        // Remove old seats
        for (let i = 2; i <= 25; i++) {
            const seat = document.getElementById(`seat-${i}`);
            if (seat) seat.remove();
        }
        // Regenerate with new dimensions
        generateVideoSeats();
    }, 250); // Wait 250ms after resize stops
});

// Make rename available globally
window.renameSelf = renameSelf;
