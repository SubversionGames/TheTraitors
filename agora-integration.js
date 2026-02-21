// ============================================
// AGORA.IO VIDEO INTEGRATION
// ============================================

const AGORA_APP_ID = 'f087e9bbafb54b0fb00dc2cf8fed6b24';
let agoraClient = null;
let localAudioTrack = null;
let localVideoTrack = null;
let remoteUsers = {};

// Get channel name for a room
function getRoomChannelName(roomId) {
    return `subversion-traitors-${roomId}`;
}

// Switch to a different room's channel
async function switchAgoraChannel(newRoomId) {
    if (!agoraClient) {
        console.log('Agora not initialized - skipping channel switch');
        return;
    }
    
    const newChannel = getRoomChannelName(newRoomId);
    
    // Don't switch if already in this channel
    if (window.currentAgoraChannel === newChannel) {
        console.log('Already in channel:', newChannel);
        return;
    }
    
    console.log('🔄 Switching from', window.currentAgoraChannel, 'to', newChannel);
    
    try {
        // Leave current channel
        await agoraClient.leave();
        console.log('Left previous channel');
        
        // Join new channel
        const uid = currentUser.seat;
        await agoraClient.join(AGORA_APP_ID, newChannel, null, uid);
        console.log('Joined new channel:', newChannel);
        
        // Update stored channel
        window.currentAgoraChannel = newChannel;
        
        // Re-publish local tracks
        if (localAudioTrack && localVideoTrack) {
            await agoraClient.publish([localAudioTrack, localVideoTrack]);
            console.log('Re-published tracks in new channel');
            
            // Re-play local video
            const localVideoDiv = document.getElementById(`video-${currentUser.seat}`);
            if (localVideoDiv) {
                localVideoDiv.innerHTML = '';
                localVideoTrack.play(localVideoDiv, { fit: 'cover' });
                
                setTimeout(() => {
                    const videoElement = localVideoDiv.querySelector('video');
                    if (videoElement) {
                        videoElement.style.transform = 'scaleX(-1)';
                    }
                }, 100);
            }
        }
    } catch (error) {
        console.error('Error switching Agora channel:', error);
    }
}

// Make globally accessible
window.switchAgoraChannel = switchAgoraChannel;

// Initialize Agora
async function initializeAgora() {
    console.log('=== AGORA INIT START ===');
    // AGORA NOW ENABLED FOR TESTING
    
    if (typeof currentUser === 'undefined') {
        console.log('currentUser not ready yet, retrying in 500ms...');
        setTimeout(initializeAgora, 500);
        return;
    }
    
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
        database.ref('players/' + currentUser.id + '/seat').once('value', (snapshot) => {
            if (snapshot.val() && !agoraClient) {
                console.log('✅ Player has seat, initializing Agora...');
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
        
        // Join channel based on current room
        const roomChannel = getRoomChannelName(currentUser.room || 'main');
        const uid = currentUser.seat; // Use seat number as UID
        
        await agoraClient.join(AGORA_APP_ID, roomChannel, null, uid);
        console.log('Joined Agora channel:', roomChannel, 'as UID:', uid);
        
        // Store current channel
        window.currentAgoraChannel = roomChannel;
        
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

        // Make tracks globally accessible for keyboard shortcuts
        window.agoraManager = {
            localAudioTrack: localAudioTrack,
            localVideoTrack: localVideoTrack
        };
        
        // Play local video in own seat
        const localVideoDiv = document.getElementById(`video-${currentUser.seat}`);
        if (localVideoDiv) {
            // Clear any existing content
            localVideoDiv.innerHTML = '';
            
            // Play video directly in the div
            localVideoTrack.play(localVideoDiv, { fit: 'cover' });
            
            console.log('Playing local video in seat', currentUser.seat);
            
            // Force mirror the video element
            setTimeout(() => {
                const videoElement = localVideoDiv.querySelector('video');
                if (videoElement) {
                    videoElement.style.transform = 'scaleX(-1)';
                    console.log('Mirrored local video');
                }
            }, 100);
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
        // Determine which seat container to use based on current room
        const seatNumber = user.uid; // UID is the seat number
        let videoDiv;
        
        if (currentUser.room === 'main') {
            // In main room, use regular seat video divs
            videoDiv = document.getElementById(`video-${seatNumber}`);
        } else {
            // In other rooms, use room-video divs
            // We need to find which room seat this player is in
            database.ref('players').once('value', (snapshot) => {
                snapshot.forEach((child) => {
                    const player = child.val();
                    if (player.seat === seatNumber && player.room === currentUser.room && player.roomSeat) {
                        const roomVideoDiv = document.getElementById(`room-video-${player.roomSeat}`);
                        if (roomVideoDiv) {
                            roomVideoDiv.innerHTML = '';
                            user.videoTrack.play(roomVideoDiv, { fit: 'cover' });
                            console.log('Playing video in room seat', player.roomSeat);
                        }
                    }
                });
            });
            return; // Exit early for non-main rooms
        }
        
        if (videoDiv) {
            videoDiv.innerHTML = '';
            user.videoTrack.play(videoDiv, { fit: 'cover' });
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
        const newState = !localAudioTrack.enabled;
        await localAudioTrack.setEnabled(newState);
        
        // Update Firebase
        const userPath = currentUser.role === 'host' ? 'players/host' : 'players/' + currentUser.id;
        database.ref(userPath + '/audioMuted').set(!newState);
        
        return !newState; // Return true if muted
    }
    return false;
}

// Turn video on/off
async function toggleVideo() {
    if (localVideoTrack) {
        const newState = !localVideoTrack.enabled;
        await localVideoTrack.setEnabled(newState);
        
        // Update Firebase
        const userPath = currentUser.role === 'host' ? 'players/host' : 'players/' + currentUser.id;
        database.ref(userPath + '/videoMuted').set(!newState);
        
        return !newState; // Return true if video off
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
