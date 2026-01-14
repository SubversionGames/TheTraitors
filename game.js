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
    
    // Seat 1 (Host) is already in HTML at top left
    // Generate seats 2-25 in a very large oval with maximum spacing
    
    const totalSeats = 24; // Seats 2-25 (24 player seats)
    const radiusX = 48; // Horizontal radius (percentage)
    const radiusY = 46; // Vertical radius (percentage)
    const centerX = 50;
    const centerY = 50;
    
    // Start from top and go clockwise
    const startAngle = -90; // Start at top
    const angleStep = 360 / totalSeats;
    
    for (let i = 0; i < totalSeats; i++) {
        const seatNumber = i + 2; // Seats 2-25
        const angle = (startAngle + (angleStep * i)) * (Math.PI / 180);
        
        // Calculate position on oval
        const x = centerX + (radiusX * Math.cos(angle));
        const y = centerY + (radiusY * Math.sin(angle));
        
        // Create seat element
        const seat = document.createElement('div');
        seat.className = 'video-seat empty';
        seat.id = `seat-${seatNumber}`;
        seat.style.left = `${x}%`;
        seat.style.top = `${y}%`;
        seat.style.transform = 'translate(-50%, -50%)';
        
        seat.innerHTML = `
            <div id="video-${seatNumber}"></div>
            <div class="seat-label">
                <span class="seat-number">Seat ${seatNumber}</span>
                <span class="player-name" id="name-${seatNumber}">Empty</span>
            </div>
            <div class="vote-indicator" id="vote-${seatNumber}"></div>
        `;
        
        // Add click handler for empty seats (player seat selection)
        seat.addEventListener('click', () => handleSeatClick(seatNumber));
        
        circle.appendChild(seat);
    }
    
    console.log('Generated 24 player seats in large oval - overlays float above');
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
    // Update all seats based on current players
    for (let i = 1; i <= 25; i++) {
        const seatElement = document.getElementById(`seat-${i}`);
        const nameElement = document.getElementById(`name-${i}`);
        
        if (!seatElement || !nameElement) continue;
        
        // Find player in this seat
        let playerInSeat = null;
        for (let playerId in gameState.players) {
            const player = gameState.players[playerId];
            if (player.seat === i && player.status !== 'ghost') {
                playerInSeat = player;
                break;
            }
        }
        
        if (playerInSeat) {
            // Seat is occupied
            seatElement.classList.remove('empty');
            seatElement.classList.add('active');
            nameElement.textContent = playerInSeat.name;
            
            // Check if player is in different room
            if (playerInSeat.room !== 'main' && playerInSeat.room !== currentUser.room) {
                // Hide video but show name
                const videoDiv = document.getElementById(`video-${i}`);
                if (videoDiv) {
                    videoDiv.style.opacity = '0.3';
                }
            }
        } else {
            // Seat is empty
            seatElement.classList.add('empty');
            seatElement.classList.remove('active');
            nameElement.textContent = i === 1 ? 'Host' : 'Empty';
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
