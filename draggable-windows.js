// ============================================
// DRAGGABLE AND COLLAPSIBLE WINDOWS
// ============================================

function makeDraggable(element) {
    const header = element.querySelector('h3');
    if (!header) return;
    
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    
    // Make header draggable
    header.style.cursor = 'move';
    header.onmousedown = dragMouseDown;
    
    function dragMouseDown(e) {
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }
    
    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        
        // Calculate new position
        let newTop = element.offsetTop - pos2;
        let newLeft = element.offsetLeft - pos1;
        
        // Boundary checks
        const maxX = window.innerWidth - element.offsetWidth;
        const maxY = window.innerHeight - element.offsetHeight;
        
        newLeft = Math.max(0, Math.min(newLeft, maxX));
        newTop = Math.max(0, Math.min(newTop, maxY));
        
        element.style.top = newTop + "px";
        element.style.left = newLeft + "px";
        element.style.right = "auto"; // Remove right positioning
        element.style.bottom = "auto"; // Remove bottom positioning
    }
    
    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
}

function makeCollapsible(element, storageKey) {
    const header = element.querySelector('h3');
    if (!header) return;
    
    // Add collapse button
    const collapseBtn = document.createElement('span');
    collapseBtn.className = 'collapse-btn';
    collapseBtn.innerHTML = '−'; // Minus sign
    collapseBtn.style.cssText = `
        float: right;
        cursor: pointer;
        font-size: 1.5rem;
        line-height: 1rem;
        user-select: none;
        margin-left: 10px;
    `;
    header.appendChild(collapseBtn);
    
    // Get content area (everything except header)
    const content = Array.from(element.children).filter(child => child !== header);
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'window-content';
    content.forEach(child => contentWrapper.appendChild(child));
    element.appendChild(contentWrapper);
    
    // Check stored state
    const isCollapsed = localStorage.getItem(storageKey) === 'true';
    if (isCollapsed) {
        contentWrapper.style.display = 'none';
        collapseBtn.innerHTML = '+';
        element.classList.add('collapsed');
    }
    
    // Toggle collapse
    collapseBtn.onclick = (e) => {
        e.stopPropagation();
        const isCurrentlyCollapsed = contentWrapper.style.display === 'none';
        
        if (isCurrentlyCollapsed) {
            contentWrapper.style.display = 'block';
            collapseBtn.innerHTML = '−';
            element.classList.remove('collapsed');
            localStorage.setItem(storageKey, 'false');
        } else {
            contentWrapper.style.display = 'none';
            collapseBtn.innerHTML = '+';
            element.classList.add('collapsed');
            localStorage.setItem(storageKey, 'true');
        }
    };
}

function saveWindowPosition(element, storageKey) {
    const position = {
        top: element.style.top,
        left: element.style.left
    };
    localStorage.setItem(storageKey + '-position', JSON.stringify(position));
}

function loadWindowPosition(element, storageKey) {
    const saved = localStorage.getItem(storageKey + '-position');
    if (saved) {
        const position = JSON.parse(saved);
        if (position.top) element.style.top = position.top;
        if (position.left) element.style.left = position.left;
        element.style.right = 'auto';
    }
}

// Initialize draggable windows on page load
document.addEventListener('DOMContentLoaded', () => {
    const waitingLobby = document.getElementById('waiting-lobby-display');
    const voteTally = document.getElementById('vote-tally');
    
    if (waitingLobby) {
        makeDraggable(waitingLobby);
        makeCollapsible(waitingLobby, 'waiting-lobby-collapsed');
        loadWindowPosition(waitingLobby, 'waiting-lobby');
        
        // Save position when dragging stops
        waitingLobby.addEventListener('mouseup', () => {
            saveWindowPosition(waitingLobby, 'waiting-lobby');
        });
    }
    
    if (voteTally) {
        makeDraggable(voteTally);
        makeCollapsible(voteTally, 'vote-tally-collapsed');
        loadWindowPosition(voteTally, 'vote-tally');
        
        voteTally.addEventListener('mouseup', () => {
            saveWindowPosition(voteTally, 'vote-tally');
        });
    }
});
