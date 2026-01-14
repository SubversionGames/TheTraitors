// Temporary placeholder for video until we implement proper video solution
function showVideoInSeat(seatNumber, userName, isHost = false) {
    const videoDiv = document.getElementById(`video-${seatNumber}`);
    if (!videoDiv) return;
    
    // Create placeholder that shows user's name
    videoDiv.innerHTML = `
        <div style="
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            font-size: 1.5rem;
            font-weight: bold;
            color: white;
        ">
            ${userName.substring(0, 2).toUpperCase()}
        </div>
    `;
}

function hideVideoInSeat(seatNumber) {
    const videoDiv = document.getElementById(`video-${seatNumber}`);
    if (videoDiv) {
        videoDiv.innerHTML = '';
    }
}

// Listen for player changes and update video placeholders
database.ref('players').on('value', (snapshot) => {
    // Clear all videos first
    for (let i = 1; i <= 25; i++) {
        hideVideoInSeat(i);
    }
    
    // Show video for each active player
    snapshot.forEach((childSnapshot) => {
        const player = childSnapshot.val();
        if (player.seat && player.status !== 'ghost') {
            showVideoInSeat(player.seat, player.name, player.isHost);
        }
    });
});
