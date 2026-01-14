/*
// ============================================
// JITSI MEET VIDEO INTEGRATION
// ============================================

let jitsiAPI = null;
let jitsiRoom = null;

// Initialize Jitsi Meet
function initializeJitsi() {
    const role = currentUser.role;
    
    if (role === 'viewer' || (role === 'player' && currentUser.status === 'ghost')) {
        // Viewers and ghosts don't join video
        console.log('Viewer/Ghost mode - no video connection');
        return;
    }
    
    // Wait for user to have a seat (for players) or be host
    if (role === 'player' && !currentUser.seat) {
        console.log('Waiting for player to select seat before joining video...');
        // Listen for seat assignment
        database.ref('players/' + currentUser.id + '/seat').on('value', (snapshot) => {
            if (snapshot.val() && !jitsiAPI) {
                initializeJitsi();
            }
        });
        return;
    }
    
    // Create unique room name for this game
    const roomName = 'SubversionTraitors_' + (window.location.hostname.replace(/\./g, '_'));
    jitsiRoom = roomName;
    
    console.log('Initializing Jitsi for', role, 'in room', roomName);
    
    // Configure Jitsi
    const domain = 'meet.jit.si';
    const options = {
        roomName: roomName,
        width: '100%',
        height: '100%',
        parentNode: document.getElementById('jitsi-container') || createJitsiContainer(),
        configOverwrite: {
            startWithAudioMuted: false,
            startWithVideoMuted: false,
            disableDeepLinking: true,
            prejoinPageEnabled: false,
            enableWelcomePage: false,
            enableClosePage: false,
            defaultLanguage: 'en',
            disableInviteFunctions: true,
            doNotStoreRoom: true,
            startScreenSharing: false,
            enableEmailInStats: false,
            enableNoisyMicDetection: true,
        },
        interfaceConfigOverwrite: {
            DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
            DISABLE_PRESENCE_STATUS: true,
            DISABLE_RINGING: true,
            SHOW_JITSI_WATERMARK: false,
            SHOW_WATERMARK_FOR_GUESTS: false,
            SHOW_BRAND_WATERMARK: false,
            TOOLBAR_BUTTONS: [
                'microphone', 'camera', 'desktop', 'fullscreen',
                'hangup', 'settings', 'videoquality', 
                'tileview', 'stats'
            ],
            SETTINGS_SECTIONS: ['devices', 'language'],
            FILM_STRIP_MAX_HEIGHT: 120,
            MOBILE_APP_PROMO: false,
        },
        userInfo: {
            displayName: currentUser.name || (role === 'host' ? 'Host' : 'Player')
        }
    };
    
    // Create Jitsi API instance
    jitsiAPI = new JitsiMeetExternalAPI(domain, options);
    
    // Event handlers
    jitsiAPI.addEventListener('videoConferenceJoined', (event) => {
        console.log('Joined video conference:', event);
        
        // Update Firebase with video status
        if (role === 'host' || role === 'player') {
            const userPath = role === 'host' ? 'game/host' : 'players/' + currentUser.id;
            database.ref(userPath + '/videoActive').set(true);
        }
        
        // If production mode, turn off video
        if (role === 'host' && sessionStorage.getItem('isProduction') === 'true') {
            jitsiAPI.executeCommand('toggleVideo');
        }
    });
    
    jitsiAPI.addEventListener('videoConferenceLeft', () => {
        console.log('Left video conference');
    });
    
    jitsiAPI.addEventListener('participantJoined', (event) => {
        console.log('Participant joined:', event);
    });
    
    jitsiAPI.addEventListener('participantLeft', (event) => {
        console.log('Participant left:', event);
    });
    
    jitsiAPI.addEventListener('audioMuteStatusChanged', (event) => {
        console.log('Audio mute status changed:', event);
    });
    
    jitsiAPI.addEventListener('videoMuteStatusChanged', (event) => {
        console.log('Video mute status changed:', event);
    });
}

function createJitsiContainer() {
    // Create hidden container for Jitsi iframe
    const container = document.createElement('div');
    container.id = 'jitsi-container';
    container.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 400px;
        height: 300px;
        z-index: 9999;
        border: 2px solid #667eea;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 5px 30px rgba(0,0,0,0.5);
        display: none;
    `;
    
    // Add toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'jitsi-toggle';
    toggleBtn.textContent = '📹 Show Video';
    toggleBtn.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 20px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        border-radius: 8px;
        font-weight: bold;
        cursor: pointer;
        z-index: 10000;
        box-shadow: 0 3px 15px rgba(0,0,0,0.3);
    `;
    
    toggleBtn.onclick = () => {
        if (container.style.display === 'none') {
            container.style.display = 'block';
            toggleBtn.textContent = '📹 Hide Video';
            toggleBtn.style.bottom = '340px'; // Move button above video
        } else {
            container.style.display = 'none';
            toggleBtn.textContent = '📹 Show Video';
            toggleBtn.style.bottom = '20px'; // Move button back down
        }
    };
    
    document.body.appendChild(toggleBtn);
    document.body.appendChild(container);
    return container;
}

// Control functions
function muteAudio() {
    if (jitsiAPI) {
        jitsiAPI.executeCommand('toggleAudio');
    }
}

function muteVideo() {
    if (jitsiAPI) {
        jitsiAPI.executeCommand('toggleVideo');
    }
}

function leaveCall() {
    if (jitsiAPI) {
        jitsiAPI.executeCommand('hangup');
        jitsiAPI.dispose();
        jitsiAPI = null;
    }
}

// Initialize Jitsi when page loads
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure game.js initializes first
    setTimeout(() => {
        initializeJitsi();
    }, 1000);
});
*/
