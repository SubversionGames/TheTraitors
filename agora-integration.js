// ============================================
// AGORA.IO VIDEO INTEGRATION
// ============================================

const AGORA_APP_ID = 'f087e9bbafb54b0fb00dc2cf8fed6b24';
let agoraClient = null;
let localAudioTrack = null;
let localVideoTrack = null;
let remoteUsers = {};

// Initialize Agora
async function initializeAgora() {
    console.log('=== AGORA INIT START ===');
    console.log('Current user role:', currentUser.role);
    console.log('Current user seat:', currentUser.seat);
    console.log('Current user name:', currentUser.name);
    
    const role = currentUser.role;
    
    if (role === 'viewer' || (role === 'player' && currentUser.status === 'ghost')) {
        console.log('Viewer/Ghost mode - no video connection');
        return;
    }
    
    // Wait for user to have a seat (for players) or be host
    if (role === 'player' && !currentUser.seat) {
        console.log('Waiting for player to select seat before joining video...');
        database.ref('players/' + currentUser.id + '/seat').on('value', (snapshot) => {
            if (snapshot.val() && !agoraClient) {
                initializeAgora();
            }
        });
        return;
    }
    
    // Host should have seat by now
    if (!currentUser.seat) {
        console.error('ERROR: No seat assigned! Cannot join video.');
        console.log('Waiting 2 seconds and trying again...');
        setTimeout(initializeAgora, 2000);
        return;
    }
    
    console.log('Initializing Agora for', role, 'in seat', currentUser.seat);
    
    try {
        // Create Agora client
        agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        
        // Event handlers
        agoraClient.on('user-published', handleUserPublished);
        agoraClient.on('user-unpublished', handleUserUnpublished);
        agoraClient.on('user-left', handleUserLeft);
        
        // Join channel (everyone joins the same channel)
        const channelName = 'subversion-traitors-main';
        const uid = currentUser.seat; // Use seat number as UID so we know which seat they're in
        
        await agoraClient.join(AGORA_APP_ID, channelName, null, uid);
        console.log('Joined Agora channel as UID:', uid);
        
        // Create and publish local tracks
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        localVideoTrack = await AgoraRTC.createCameraVideoTrack({
            encoderConfig: {
                width: 640,
                height: 480,
                frameRate: 15,
                bitrateMax: 600,
            }
        });
        
        await agoraClient.publish([localAudioTrack, localVideoTrack]);
        console.log('Published local tracks');
        
        // Play local video in own seat
        const localVideoDiv = document.getElementById(`video-${currentUser.seat}`);
        if (localVideoDiv) {
            localVideoTrack.play(localVideoDiv);
        }
        
        // Update Firebase with video status
        const userPath = role === 'host' ? 'players/host' : 'players/' + currentUser.id;
        database.ref(userPath + '/videoActive').set(true);
        
    } catch (error) {
        console.error('Error initializing Agora:', error);
        alert('Could not connect to video. Please check your camera/microphone permissions.');
    }
}

// Handle when remote user publishes their track
async function handleUserPublished(user, mediaType) {
    console.log('Remote user published:', user.uid, mediaType);
    
    // Subscribe to remote user
    await agoraClient.subscribe(user, mediaType);
    console.log('Subscribed to', user.uid, mediaType);
    
    // Store remote user
    remoteUsers[user.uid] = user;
    
    if (mediaType === 'video') {
        // Play remote video in their seat
        const seatNumber = user.uid; // UID is the seat number
        const remoteVideoDiv = document.getElementById(`video-${seatNumber}`);
        
        if (remoteVideoDiv) {
            user.videoTrack.play(remoteVideoDiv);
            console.log('Playing video for seat', seatNumber);
        }
    }
    
    if (mediaType === 'audio') {
        user.audioTrack.play();
    }
}

// Handle when remote user unpublishes
function handleUserUnpublished(user, mediaType) {
    console.log('Remote user unpublished:', user.uid, mediaType);
    
    if (mediaType === 'video') {
        const seatNumber = user.uid;
        const remoteVideoDiv = document.getElementById(`video-${seatNumber}`);
        if (remoteVideoDiv) {
            remoteVideoDiv.innerHTML = '';
        }
    }
}

// Handle when remote user leaves
function handleUserLeft(user) {
    console.log('Remote user left:', user.uid);
    delete remoteUsers[user.uid];
    
    const seatNumber = user.uid;
    const remoteVideoDiv = document.getElementById(`video-${seatNumber}`);
    if (remoteVideoDiv) {
        remoteVideoDiv.innerHTML = '';
    }
}

// Mute/unmute audio
async function toggleAudio() {
    if (localAudioTrack) {
        await localAudioTrack.setEnabled(!localAudioTrack.enabled);
        return !localAudioTrack.enabled; // Return true if muted
    }
    return false;
}

// Turn video on/off
async function toggleVideo() {
    if (localVideoTrack) {
        await localVideoTrack.setEnabled(!localVideoTrack.enabled);
        return !localVideoTrack.enabled; // Return true if video off
    }
    return false;
}

// Leave call
async function leaveAgoraCall() {
    if (localAudioTrack) {
        localAudioTrack.close();
    }
    if (localVideoTrack) {
        localVideoTrack.close();
    }
    if (agoraClient) {
        await agoraClient.leave();
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        initializeAgora();
    }, 2000);
});
