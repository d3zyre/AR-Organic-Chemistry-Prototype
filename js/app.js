class ARChemistryApp {
    constructor() {
        this.video = null;
        this.canvas = null;
        this.ctx = null;
        this.hands = null;
        this.isTracking = false;

        this.fingerCursor = null;
        this.status = null;
        this.moleculeContainer = null;
        this.discoveredList = null;

        this.draggedElement = null;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.placedElements = [];
        this.discoveredMolecules = [];
        this.spawnedAtoms = [];

        // C3 intermediates (cyclic three-carbon) bookkeeping
        this.ccIntermediates = [];

        // pinch debounce
        this.isPinching = false;
        this.lastRelease = 0;

        this.init();
    }

    async init() {
        try {
            this.updateStatus('Initializing webcam...');
            await this.initializeWebcam();

            this.updateStatus('Setting up MediaPipe...');
            await this.initializeMediaPipe();

            this.updateStatus('Starting hand tracking...');
            this.startHandTracking();

            this.updateStatus('Ready! Pinch over palette to spawn atoms, then drag them');

        } catch (error) {
            console.error('Initialization failed:', error);
            this.updateStatus('Failed to initialize: ' + error.message);
        }
    }

    async initializeWebcam() {
        this.video = document.getElementById('webcam');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                }
            });

            this.video.srcObject = stream;

            return new Promise((resolve) => {
                this.video.onloadedmetadata = () => {
                    this.video.play();
                    resolve();
                };
            });

        } catch (error) {
            throw new Error('Webcam access denied or not available');
        }
    }

    async initializeMediaPipe() {
        this.canvas = document.getElementById('hand-canvas');
        this.ctx = this.canvas.getContext('2d');

        this.updateCanvasSize();

        if (typeof Hands === 'undefined') {
            throw new Error('MediaPipe Hands not loaded. Please check your internet connection.');
        }

        this.hands = new Hands({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`;
            }
        });

        this.hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 0,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        this.hands.onResults(this.onResults.bind(this));

        this.startVideoProcessing();
    }

    startVideoProcessing() {
        const processFrame = async () => {
            if (this.isTracking && this.video.readyState === 4) {
                try {
                    await this.hands.send({ image: this.video });
                } catch (error) {
                    console.error('Error processing frame:', error);
                }
            }
            requestAnimationFrame(processFrame);
        };

        this.isTracking = true;
        processFrame();
    }

    updateCanvasSize() {
        if (!this.canvas) return;
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    startHandTracking() {
        this.fingerCursor = document.getElementById('finger-cursor');
        this.status = document.getElementById('status');
        this.moleculeContainer = document.getElementById('molecule-container');
        this.discoveredList = document.getElementById('discovered-list');

        this.updateDiscoveredList();

        window.addEventListener('resize', () => {
            this.updateCanvasSize();
        });

        const clearBtn = document.getElementById('clear-button');
        if (clearBtn) clearBtn.addEventListener('click', () => this.clearAll());
    }

    onResults(results) {
        if (!this.ctx) return;
        // clear canvas each frame so skeleton doesn't stick
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const handLandmarks = results.multiHandLandmarks[0];
            this.processHandLandmarks(handLandmarks);
            this.detectPinchGesture(handLandmarks);
            this.updateFingerCursor(handLandmarks);
            this.handleElementInteraction(handLandmarks);
        } else {
            this.hideFingerCursor();
        }
    }

    processHandLandmarks(landmarks) {
        this.drawHandConnections(landmarks);
        this.drawHandLandmarks(landmarks);
    }

    drawHandConnections(landmarks) {
        const connections = [
            [0, 1], [1, 2], [2, 3], [3, 4],
            [0, 5], [5, 6], [6, 7], [7, 8],
            [5, 9], [9, 10], [10, 11], [11, 12],
            [9, 13], [13, 14], [14, 15], [15, 16],
            [13, 17], [17, 18], [18, 19], [19, 20],
            [0, 17]
        ];

        connections.forEach(([start, end]) => {
            const startPoint = landmarks[start];
            const endPoint = landmarks[end];

            if (startPoint && endPoint) {
                this.ctx.beginPath();
                this.ctx.moveTo(
                    this.getCorrectedX(startPoint.x * this.canvas.width),
                    startPoint.y * this.canvas.height
                );
                this.ctx.lineTo(
                    this.getCorrectedX(endPoint.x * this.canvas.width),
                    endPoint.y * this.canvas.height
                );
                this.ctx.strokeStyle = 'rgba(0, 255, 136, 0.8)';
                this.ctx.lineWidth = 3;
                this.ctx.stroke();
            }
        });
    }

    drawHandLandmarks(landmarks) {
        landmarks.forEach((landmark) => {
            this.ctx.beginPath();
            this.ctx.arc(
                this.getCorrectedX(landmark.x * this.canvas.width),
                landmark.y * this.canvas.height,
                4,
                0,
                2 * Math.PI
            );
            this.ctx.fillStyle = 'rgba(0, 255, 136, 0.9)';
            this.ctx.fill();
        });
    }

    detectPinchGesture(landmarks) {
        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];

        if (indexTip && thumbTip) {
            const distance = Math.sqrt(
                Math.pow(indexTip.x - thumbTip.x, 2) +
                Math.pow(indexTip.y - thumbTip.y, 2)
            );

            const isPinching = distance < 0.08;

            if (isPinching && !this.isPinching) {
                if (!this.lastRelease || Date.now() - this.lastRelease > 120) {
                    this.isPinching = true;
                    this.pinchStartTime = Date.now();
                    this.handlePinchStart(indexTip);
                }
            } else if (!isPinching && this.isPinching) {
                this.isPinching = false;
                this.lastRelease = Date.now();
                this.handlePinchRelease(indexTip);
            }
        }
    }

    // Helper: simulate a pinch click on a button by dispatching pointer events + click
    _simulatePinchClick(el) {
        try {
            // pointerdown
            const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' });
            el.dispatchEvent(pd);
            // pointerup
            const pu = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' });
            el.dispatchEvent(pu);
            // click
            const clk = new MouseEvent('click', { bubbles: true, cancelable: true });
            el.dispatchEvent(clk);
        } catch (e) {
            // fallback to direct click if events don't work
            try { el.click(); } catch (err) { /* ignore */ }
        }
    }

    handlePinchStart(indexTip) {
        // compute page coords for the pinch
        const x = this.getCorrectedX(indexTip.x * window.innerWidth);
        const y = indexTip.y * window.innerHeight;

        // 1) If a bond-popup is visible, check if pinch is over any button and trigger it
        const popup = document.querySelector('.bond-popup');
        if (popup) {
            const btnIds = ['bond-single', 'bond-double', 'bond-triple', 'bond-cancel'];
            for (const id of btnIds) {
                const btn = popup.querySelector(`#${id}`);
                if (!btn) continue;
                const rect = btn.getBoundingClientRect();
                if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    this._simulatePinchClick(btn);
                    // small debounce so it doesn't immediately re-trigger other actions
                    this.lastRelease = Date.now();
                    return; // pinch consumed
                }
            }
            // If popup visible and pinch not on button, consume pinch (prevents accidental spawns)
            return;
        }

        // If already dragging, ignore spawning or other interactions
        if (this.isDragging) return;

        // check clear button area
        const clearBtn = document.getElementById('clear-button');
        if (clearBtn) {
            const rect = clearBtn.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                this.clearAll();
                return;
            }
        }

        // 2) Check if pinching a molecule (intermediate or final) -> make it draggable
        const moleculeHit = this.getMoleculeAtPosition(x, y);
        if (moleculeHit) {
            // create a lightweight data object that works with startDragging
            const md = { element: moleculeHit, type: 'molecule', id: moleculeHit.dataset && moleculeHit.dataset.id ? moleculeHit.dataset.id : ('mol-' + Date.now()) };
            // ensure molecule has position style (absolute)
            moleculeHit.style.position = 'absolute';
            this.startDragging(md, x, y);
            return;
        }

        // 3) First check if pinching a spawned atom
        const spawnedAtom = this.getSpawnedAtomAtPosition(x, y);
        if (spawnedAtom && !this.draggedElement) {
            this.startDragging(spawnedAtom, x, y);
            return;
        }

        // 4) Otherwise spawn from palette
        const paletteElement = this.getPaletteElementAtPosition(x, y);
        if (paletteElement) {
            const elementType = paletteElement.dataset.element;
            this.spawnAtom(elementType, x, y);
        }
    }

    handlePinchRelease(indexTip) {
        this.isPinching = false;

        if (this.isDragging && this.draggedElement) {
            const x = this.getCorrectedX(indexTip.x * window.innerWidth);
            const y = indexTip.y * window.innerHeight;
            this.dropElement(x, y);
        }
    }

    getCorrectedX(x) {
        return window.innerWidth - x;
    }

    getPaletteElementAtPosition(x, y) {
        const elements = document.querySelectorAll('.element');

        for (const element of elements) {
            const rect = element.getBoundingClientRect();

            if (x >= rect.left && x <= rect.right &&
                y >= rect.top && y <= rect.bottom) {
                return element;
            }
        }

        return null;
    }

    // returns topmost molecule under x,y or null
    getMoleculeAtPosition(x, y) {
        const molecules = Array.from(document.querySelectorAll('.molecule')).reverse(); // topmost first
        for (const m of molecules) {
            const rect = m.getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                return m;
            }
        }
        return null;
    }

    clearAll() {
        this.spawnedAtoms.forEach(item => {
            if (item.element && item.element.parentNode) {
                item.element.remove();
            }
        });
        this.spawnedAtoms = [];

        document.querySelectorAll('.molecule').forEach(mol => mol.remove());

        this.ccIntermediates.forEach(i=>{ if (i.element && i.element.parentNode) i.element.remove(); });
        this.ccIntermediates = [];

        this.draggedElement = null;
        this.isDragging = false;
        this.isPinching = false;

        this.updateStatus('Cleared all atoms and molecules.');
    }

    spawnAtom(elementType, x, y) {
        const elementName = this.getElementName(elementType);
        this.updateStatus(`Spawned ${elementName} atom - pinch to drag`);

        const atom = document.createElement('div');
        atom.className = 'spawned-atom';
        atom.dataset.element = elementType;
        atom.dataset.id = Date.now() + Math.random();

        atom.innerHTML = `
            <div class="atom ${elementType.toLowerCase()}">${elementType}</div>
        `;

        const containerRect = this.moleculeContainer.getBoundingClientRect();
        const spawnX = Math.max(
            30,
            Math.min(containerRect.width - 60, x - containerRect.left - 30)
        );
        const spawnY = Math.max(
            30,
            Math.min(containerRect.height - 60, y - containerRect.top - 30)
        );

        atom.style.left = `${spawnX}px`;
        atom.style.top = `${spawnY}px`;
        atom.style.position = 'absolute';

        this.moleculeContainer.appendChild(atom);

        const atomData = {
            element: atom,
            type: elementType,
            x: spawnX,
            y: spawnY,
            id: atom.dataset.id
        };

        this.spawnedAtoms.push(atomData);
    }

    getElementName(elementType) {
        const names = { 'C': 'Carbon', 'H': 'Hydrogen', 'O': 'Oxygen' };
        return names[elementType] || elementType;
    }

    // startDragging supports both spawned atoms and molecules
    startDragging(atomData, x, y) {
        this.draggedElement = atomData;
        this.isDragging = true;

        const rect = atomData.element.getBoundingClientRect();
        this.dragOffset.x = x - rect.left;
        this.dragOffset.y = y - rect.top;

        // mark draggable visual
        atomData.element.classList.add('dragging');
        atomData.element.style.pointerEvents = 'none';
        atomData.element.style.cursor = 'grabbing';

        // If it's a molecule, keep its dataset.id for potential persistence
        if (atomData.type === 'molecule') {
            // ensure molecule has dataset.id (use if not present)
            if (!atomData.element.dataset.id) atomData.element.dataset.id = 'mol-' + Date.now();
            this.updateStatus('Grabbed molecule (drag to move)');
        } else {
            this.updateStatus(`Grabbed ${this.getElementName(atomData.type)} atom`);
        }
    }

    // dropElement: handles molecules specially and also attachments / merges for atoms
    dropElement(x, y) {
        if (!this.draggedElement) return;

        const draggedRef = this.draggedElement;

        // restore visuals for element
        try {
            draggedRef.element.classList.remove('dragging');
            draggedRef.element.style.pointerEvents = '';
            draggedRef.element.style.cursor = '';
        } catch (e) { /* ignore */ }

        // If we're dragging a molecule, just drop and update its position
        if (draggedRef.type === 'molecule') {
            // set final position within container bounds
            const containerRect = this.moleculeContainer.getBoundingClientRect();
            const rect = draggedRef.element.getBoundingClientRect();
            let finalLeft = x - this.dragOffset.x - containerRect.left;
            let finalTop = y - this.dragOffset.y - containerRect.top;
            const w = rect.width, h = rect.height;
            finalLeft = Math.max(0, Math.min(containerRect.width - w, finalLeft));
            finalTop = Math.max(0, Math.min(containerRect.height - h, finalTop));
            draggedRef.element.style.left = `${finalLeft}px`;
            draggedRef.element.style.top = `${finalTop}px`;

            // clear drag state
            this.draggedElement = null;
            this.isDragging = false;
            this.isPinching = false;

            this.updateStatus('Moved molecule');
            return;
        }

        // For atom drops: first check if dropped onto an existing C3 intermediate -> handle H-attachment
        const topElems = document.elementsFromPoint(x, y);
        const molEl = topElems.find(e => e.classList && e.classList.contains('molecule'));
        // handle C3 before C2
        if (molEl && molEl.dataset && molEl.dataset.base === 'C3') {
            if (draggedRef.type === 'H') {
                const prev = parseInt(molEl.dataset.hcount || '0', 10);
                const required = parseInt(molEl.dataset.required || '6', 10);
                const now = prev + 1;
                molEl.dataset.hcount = String(now);

                // remove H atom from scene & spawnedAtoms
                this.removeAtoms([draggedRef]);

                this.updateStatus(`Attached H to C₃ intermediate — ${now}/${required} H attached`);

                if (now >= required) {
                    // finalize to Cyclopropane (C3H6)
                    const r = molEl.getBoundingClientRect();
                    const centerX = r.left + r.width / 2;
                    const centerY = r.top + r.height / 2;
                    molEl.remove();
                    this.createMoleculeVisual('Cyclopropane', 'C₃H₆', [], centerX, centerY, { style: 'c3h6-detailed' });
                    this.updateStatus('Cyclopropane formed (C₃H₆)');
                }

                // clear internal drag state
                this.draggedElement = null;
                this.isDragging = false;
                this.isPinching = false;
                return;
            }
        }

        // For atom drops: first check if dropped onto an existing C2 intermediate -> handle H-attachment
        if (molEl && molEl.dataset && molEl.dataset.base === 'C2') {
            if (draggedRef.type === 'H') {
                const prev = parseInt(molEl.dataset.hcount || '0', 10);
                const required = parseInt(molEl.dataset.required || '0', 10);
                const now = prev + 1;
                molEl.dataset.hcount = String(now);

                // attach hydrogen visually to correct carbon center
                this._attachHydrogenToC2Visual(molEl, now);

                // remove H atom from scene & spawnedAtoms
                this.removeAtoms([draggedRef]);

                this.updateStatus(`Attached H to ${molEl.dataset.bond} bond — ${now}/${required} H attached`);

                // if we've reached required Hs, convert intermediate to final molecule
                if (now >= required) {
                    const bondType = molEl.dataset.bond || 'single';
                    let name = 'C2Hx', formula = 'C2Hx', style = null;
                    if (bondType === 'single') { name = 'Ethane'; formula = 'C2H6'; style = 'c2single-detailed'; }
                    else if (bondType === 'double') { name = 'Ethene'; formula = 'C2H4'; style = 'c2h4-detailed'; }
                    else if (bondType === 'triple') { name = 'Ethyne'; formula = 'C2H2'; style = 'c2h2-detailed'; }

                    const r = molEl.getBoundingClientRect();
                    const centerX = r.left + r.width / 2;
                    const centerY = r.top + r.height / 2;

                    molEl.remove();
                    this.createMoleculeVisual(name, formula, [], centerX, centerY, { style });
                    this.updateStatus(`${name} formed (${formula})`);
                }

                // clear internal drag state AFTER handling
                this.draggedElement = null;
                this.isDragging = false;
                this.isPinching = false;
                return;
            }
        }

        // If not attaching to intermediate — detect merge with another spawned carbon (C + C)
        const mergeThreshold = 70; // px

        // SPECIAL: if dragging a Carbon, check for an existing nearby *pair* of carbons to form a cyclic C3 intermediate
        if (draggedRef.type === 'C') {
            const others = this.spawnedAtoms.filter(a => a !== draggedRef && a.type === 'C');
            const pairThreshold = 90;
            let pair = null;
            for (let i=0;i<others.length;i++){
                for (let j=i+1;j<others.length;j++){
                    try {
                        const r1 = others[i].element.getBoundingClientRect();
                        const r2 = others[j].element.getBoundingClientRect();
                        const c1 = { x: r1.left + r1.width/2, y: r1.top + r1.height/2 };
                        const c2 = { x: r2.left + r2.width/2, y: r2.top + r2.height/2 };
                        const d = Math.hypot(c1.x - c2.x, c1.y - c2.y);
                        if (d < pairThreshold) { pair = [others[i], others[j]]; break; }
                    } catch(e) { /* ignore */ }
                }
                if (pair) break;
            }

            if (pair) {
                try {
                    const pr1 = pair[0].element.getBoundingClientRect();
                    const pr2 = pair[1].element.getBoundingClientRect();
                    const centroid = { x: (pr1.left + pr1.width/2 + pr2.left + pr2.width/2)/2, y: (pr1.top + pr1.height/2 + pr2.top + pr2.height/2)/2 };
                    const draggedRect = draggedRef.element.getBoundingClientRect();
                    const draggedCenter = { x: draggedRect.left + draggedRect.width/2, y: draggedRect.top + draggedRect.height/2 };
                    const dToCentroid = Math.hypot(draggedCenter.x - centroid.x, draggedCenter.y - centroid.y);

                    if (dToCentroid < 120) {
                        // remove the three carbon atoms from scene & spawnedAtoms
                        this.removeAtoms([pair[0], pair[1], draggedRef]);

                        const midX = centroid.x;
                        const midY = centroid.y;

                        // create C3 intermediate DOM
                        const mol = document.createElement('div');
                        mol.className = 'molecule';
                        mol.dataset.base = 'C3';
                        mol.dataset.hcount = '0';
                        mol.dataset.required = '6';
                        mol.dataset.type = 'cyclic';
                        mol.style.position = 'absolute';
                        const size = 260;
                        mol.style.width = `${size}px`;
                        mol.style.height = `${size}px`;

                        const containerRect = this.moleculeContainer.getBoundingClientRect();
                        const relLeft = Math.max(0, Math.min(containerRect.width - size, midX - containerRect.left - size/2));
                        const relTop = Math.max(0, Math.min(containerRect.height - size, midY - containerRect.top - size/2));
                        mol.style.left = `${relLeft}px`;
                        mol.style.top = `${relTop}px`;

                        mol.innerHTML = `<div class="molecule-structure"></div>`;
                        const struct = mol.querySelector('.molecule-structure');
                        struct.style.position = 'absolute';
                        struct.style.left = '50%'; struct.style.top='50%'; struct.style.transform='translate(-50%,-50%)';
                        struct.style.width = `${size}px`; struct.style.height = `${size}px`; struct.style.pointerEvents='none';

                        // draw ring
                        const centerX = size/2, centerY = size/2, r = 72;
                        const angles = [ -90, 30, 150 ];
                        const makeNode = (label, ax, ay) => {
                            const n = document.createElement('div');
                            n.className = 'atom carbon'; n.textContent = label; n.style.position='absolute'; const asize=55; n.style.left=`${ax - asize/2}px`; n.style.top=`${ay - asize/2}px`; return n;
                        };
                        const positions = angles.map(a=>{ const rad=a*Math.PI/180; return { x: centerX + Math.cos(rad)*r, y: centerY + Math.sin(rad)*r }; });
                        const makeBond = (x1,y1,x2,y2) => { const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI; const left=Math.min(x1,x2), top=Math.min(y1,y2); const b=document.createElement('div'); b.className='bond'; b.style.position='absolute'; b.style.left=`${left}px`; b.style.top=`${top}px`; b.style.width=`${len}px`; b.style.height='4px'; b.style.transformOrigin='0 50%'; b.style.transform = `translate(${x1-left}px,${y1-top}px) rotate(${ang}deg)`; b.style.background='#00ff88'; b.style.borderRadius='2px'; return b; };

                        struct.appendChild(makeBond(positions[0].x,positions[0].y, positions[1].x,positions[1].y));
                        struct.appendChild(makeBond(positions[1].x,positions[1].y, positions[2].x,positions[2].y));
                        struct.appendChild(makeBond(positions[2].x,positions[2].y, positions[0].x,positions[0].y));
                        struct.appendChild(makeNode('C', positions[0].x, positions[0].y));
                        struct.appendChild(makeNode('C', positions[1].x, positions[1].y));
                        struct.appendChild(makeNode('C', positions[2].x, positions[2].y));

                        mol.style.borderRadius = '50%';
                        mol.style.boxShadow = '0 0 0 2px rgba(255,255,255,0.02) inset';

                        this.moleculeContainer.appendChild(mol);

                        // register as intermediate
                        const intermObj = { element: mol, type: 'C3', x: relLeft, y: relTop, hcount: 0, required:6 };
                        this.ccIntermediates.push(intermObj);

                        this.updateStatus('C₃ intermediate created — attach 6 H atoms to form Cyclopropane (C₃H₆)');

                        // done: clear drag state
                        this.draggedElement = null; this.isDragging = false; this.isPinching = false; return;
                    }
                } catch(e) { /* ignore */ }
            }
        }

        const candidate = this.spawnedAtoms.find(a => a !== draggedRef && this._distanceBetweenAtoms(a, draggedRef) < mergeThreshold);

        // clear internal drag state
        this.draggedElement = null;
        this.isDragging = false;
        this.isPinching = false;

        if (candidate) {
            if (candidate.type === 'C' && draggedRef.type === 'C') {
                this._showBondChoicePopupForPair(candidate, draggedRef);
                return;
            }
        }

        // Default drop
        const elementType = draggedRef.type;
        const elementName = this.getElementName(elementType);
        this.updateStatus(`Dropped ${elementName} atom`);

        if (typeof this.checkForMoleculeFormation === 'function') {
            this.checkForMoleculeFormation();
        }
    }

    getSpawnedAtomAtPosition(x, y) {
        for (const atomData of this.spawnedAtoms) {
            const rect = atomData.element.getBoundingClientRect();

            if (x >= rect.left && x <= rect.right &&
                y >= rect.top && y <= rect.bottom) {
                return atomData;
            }
        }

        return null;
    }

    updateFingerCursor(landmarks) {
        const indexTip = landmarks[8];

        if (indexTip && this.fingerCursor) {
            const x = this.getCorrectedX(indexTip.x * window.innerWidth);
            const y = indexTip.y * window.innerHeight;

            this.fingerCursor.style.left = `${x - 12}px`;
            this.fingerCursor.style.top = `${y - 12}px`;
            this.fingerCursor.classList.add('active');
        }
    }

    hideFingerCursor() {
        if (this.fingerCursor) {
            this.fingerCursor.classList.remove('active');
        }
    }

    handleElementInteraction(landmarks) {
        if (this.isDragging) {
            const indexTip = landmarks[8];
            if (indexTip) {
                const x = this.getCorrectedX(indexTip.x * window.innerWidth);
                const y = indexTip.y * window.innerHeight;
                this.updateDragPosition(x, y);
            }
        }
    }

    updateDragPosition(x, y) {
        if (!this.isDragging || !this.draggedElement) return;

        const containerRect = this.moleculeContainer.getBoundingClientRect();

        // If dragging a molecule, clamp using its own dimensions
        if (this.draggedElement.type === 'molecule') {
            const rect = this.draggedElement.element.getBoundingClientRect();
            let finalLeft = x - this.dragOffset.x - containerRect.left;
            let finalTop = y - this.dragOffset.y - containerRect.top;
            finalLeft = Math.max(0, Math.min(containerRect.width - rect.width, finalLeft));
            finalTop = Math.max(0, Math.min(containerRect.height - rect.height, finalTop));
            this.draggedElement.element.style.left = `${finalLeft}px`;
            this.draggedElement.element.style.top = `${finalTop}px`;
            return;
        }

        // default: atom dragging behavior
        let relX = x - this.dragOffset.x - containerRect.left;
        let relY = y - this.dragOffset.y - containerRect.top;

        const atomSize = 60;
        relX = Math.max(0, Math.min(containerRect.width - atomSize, relX));
        relY = Math.max(0, Math.min(containerRect.height - atomSize, relY));

        this.draggedElement.element.style.left = `${relX}px`;
        this.draggedElement.element.style.top = `${relY}px`;

        this.draggedElement.x = relX;
        this.draggedElement.y = relY;
    }

    // ---------- Helper: distance between spawned atom centers ----------
    _distanceBetweenAtoms(a, b) {
        try {
            const ra = a.element.getBoundingClientRect();
            const rb = b.element.getBoundingClientRect();
            const ax = ra.left + ra.width / 2;
            const ay = ra.top + ra.height / 2;
            const bx = rb.left + rb.width / 2;
            const by = rb.top + rb.height / 2;
            return Math.hypot(ax - bx, ay - by);
        } catch (e) {
            return Infinity;
        }
    }

    // ---------- Show bond choice popup (pinch-selectable) ----------
    _showBondChoicePopupForPair(atomA, atomB) {
        if (!atomA || !atomB) { if (typeof this.checkForMoleculeFormation === 'function') this.checkForMoleculeFormation(); return; }

        const ra = atomA.element.getBoundingClientRect();
        const rb = atomB.element.getBoundingClientRect();
        const mx = (ra.left + rb.left + ra.width + rb.width) / 4;
        const my = Math.min(ra.top, rb.top) - 10;

        // remove previous popup if present
        const prev = document.querySelector('.bond-popup');
        if (prev && prev.parentNode) prev.remove();

        const popup = document.createElement('div');
        popup.className = 'bond-popup';
        popup.style.position = 'absolute';
        popup.style.left = `${mx}px`;
        popup.style.top = `${Math.max(8, my)}px`;
        popup.style.zIndex = 4000;
        popup.style.minWidth = '220px';
        popup.style.background = 'rgba(12,12,12,0.95)';
        popup.style.color = '#fff';
        popup.style.padding = '8px';
        popup.style.borderRadius = '8px';
        popup.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
        popup.innerHTML = `
          <div class="bp-heading" style="font-size:13px;margin-bottom:6px;">Create bond between selected atoms?</div>
          <div class="bp-row" style="display:flex;gap:6px;justify-content:space-between;">
            <button class="bp-btn single" id="bond-single" style="flex:1;padding:8px;border-radius:6px;background:#222;color:#fff;border:0;">Single</button>
            <button class="bp-btn double" id="bond-double" style="flex:1;padding:8px;border-radius:6px;background:#222;color:#fff;border:0;">Double</button>
            <button class="bp-btn triple" id="bond-triple" style="flex:1;padding:8px;border-radius:6px;background:#222;color:#fff;border:0;">Triple</button>
            <button class="bp-btn" id="bond-cancel" style="flex:0 0 56px;padding:8px;border-radius:6px;background:#444;color:#fff;border:0;margin-left:6px;">✕</button>
          </div>
        `;
        document.body.appendChild(popup);

        const cleanup = () => { if (popup && popup.parentNode) popup.remove(); };

        // selection handlers — identical to previous but also safe for programmatic click
        popup.querySelector('#bond-single').addEventListener('click', () => {
            cleanup();
            this._createC2Intermediate(atomA, atomB, 'single');
        });

        popup.querySelector('#bond-double').addEventListener('click', () => {
            cleanup();
            this._createC2Intermediate(atomA, atomB, 'double');
        });

        popup.querySelector('#bond-triple').addEventListener('click', () => {
            cleanup();
            this._createC2Intermediate(atomA, atomB, 'triple');
        });

        popup.querySelector('#bond-cancel').addEventListener('click', () => {
            cleanup();
            if (typeof this.checkForMoleculeFormation === 'function') this.checkForMoleculeFormation();
        });

        // auto close
        setTimeout(() => {
            if (popup.parentNode) { cleanup(); if (typeof this.checkForMoleculeFormation === 'function') this.checkForMoleculeFormation(); }
        }, 9000);
    }

    // ---------- Create C2 intermediate visual & bookkeeping ----------
    _createC2Intermediate(atomA, atomB, bondType = 'single') {
        // remove the two carbon atoms from spawnedAtoms and DOM
        this.removeAtoms([atomA, atomB]);

        // position the intermediate where the two were (midpoint)
        const ra = atomA.element.getBoundingClientRect();
        const rb = atomB.element.getBoundingClientRect();
        const midX = (ra.left + rb.left + ra.width + rb.width) / 4;
        const midY = (ra.top + rb.top + ra.height + rb.height) / 4;

        // Create a molecule card that represents the C2 intermediate
        const name = (bondType === 'single') ? 'C–C (single)' : (bondType === 'double') ? 'C=C (double)' : 'C≡C (triple)';
        const formula = 'C2'; // intermediate label
        const molecule = document.createElement('div');
        molecule.className = 'molecule';
        molecule.dataset.base = 'C2';
        molecule.dataset.bond = bondType;       // 'single' | 'double' | 'triple'
        molecule.dataset.hcount = '0';          // attached Hs so far
        molecule.dataset.required = (bondType === 'single') ? '6' : (bondType === 'double') ? '4' : '2';
        molecule.style.position = 'absolute';

        molecule.innerHTML = `<div class="molecule-title">${name}</div><div class="molecule-structure"></div>`;
        const width = 240, height = 240;
        molecule.style.width = `${width}px`;
        molecule.style.height = `${height}px`;

        const containerRect = this.moleculeContainer.getBoundingClientRect();
        const relLeft = Math.max(0, Math.min(containerRect.width - width, midX - containerRect.left - width / 2));
        const relTop  = Math.max(0, Math.min(containerRect.height - height, midY - containerRect.top - height / 2));
        molecule.style.left = `${relLeft}px`;
        molecule.style.top = `${relTop}px`;

        const structure = molecule.querySelector('.molecule-structure');
        structure.style.position = 'absolute';
        structure.style.left = '50%';
        structure.style.top = '50%';
        structure.style.transform = 'translate(-50%,-50%)';
        structure.style.width = `${width}px`;
        structure.style.height = `${height}px`;
        structure.style.pointerEvents = 'none';

        // draw only the two carbons and the chosen bond (no hydrogens yet)
        const cx = width/2, cy = height/2;
        const spacing = 40;
        const c1x = cx - spacing, c2x = cx + spacing;

        const makeNode = (cls, label, x, y) => {
            const n = document.createElement('div');
            n.className = `atom ${cls}`;
            n.textContent = label;
            n.style.position = 'absolute';
            const size = (cls === 'hydrogen') ? 40 : 55;
            n.style.left = `${x - size/2}px`;
            n.style.top = `${y - size/2}px`;
            return n;
        };

        const c1 = makeNode('carbon', 'C', c1x, cy);
        const c2 = makeNode('carbon', 'C', c2x, cy);

        // draw bond between c1 and c2 with correct multiplicity
        const drawBond = (x1, y1, x2, y2, bond) => {
            // Ensure bond line coordinates are relative to the structure element (we are operating in that space)
            const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
            // compute where to place the bond DOM element inside `structure`
            // left/top = min coords, transform translates from x1-left and rotate
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);

            const createLine = (ox = 0, oy = 0) => {
                const b = document.createElement('div');
                b.className = 'bond';
                b.style.position = 'absolute';
                b.style.left = `${left}px`;
                b.style.top = `${top}px`;
                b.style.width = `${len}px`;
                b.style.height = '4px';
                b.style.transformOrigin = '0 50%';
                // translate by (x1-left + offsetX, y1-top + offsetY) then rotate
                b.style.transform = `translate(${x1 - left + ox}px, ${y1 - top + oy}px) rotate(${ang}deg)`;
                b.style.background = '#00ff88';
                b.style.borderRadius = '2px';
                return b;
            };

            if (bond === 'single') {
                structure.appendChild(createLine());
            } else if (bond === 'double') {
                const offset = 6;
                const nx = -dy / (len || 1), ny = dx / (len || 1);
                structure.appendChild(createLine(nx * offset, ny * offset));
                structure.appendChild(createLine(-nx * offset, -ny * offset));
            } else if (bond === 'triple') {
                const offset = 8;
                const nx = -dy / (len || 1), ny = dx / (len || 1);
                structure.appendChild(createLine(0, 0));
                structure.appendChild(createLine(nx * offset, ny * offset));
                structure.appendChild(createLine(-nx * offset, -ny * offset));
            }
        };

        drawBond(c1x, cy, c2x, cy, bondType);
        structure.appendChild(c1);
        structure.appendChild(c2);

        // subtle title styling
        const titleEl = molecule.querySelector('.molecule-title');
        if (titleEl) {
            titleEl.style.position = 'absolute';
            titleEl.style.top = '10px';
            titleEl.style.left = '50%';
            titleEl.style.transform = 'translateX(-50%)';
            titleEl.style.zIndex = '10';
            titleEl.style.pointerEvents = 'auto';
        }

        // append to container
        this.moleculeContainer.appendChild(molecule);

        // store internal positions for later hydrogen attachments (positions are inside structure coords)
        molecule._internal = {
            c1pos: { x: c1x, y: cy },
            c2pos: { x: c2x, y: cy },
            hydrogens: []
        };

        // make molecule draggable: add a small invisible hit area so that pinch-detection over molecule finds it
        molecule.style.touchAction = 'none'; // helpful for pointer events if used elsewhere

        this.updateStatus(`${name} created — attach H atoms to convert to full molecule`);
    }

    // ---------- Attach hydrogen to C2 intermediate; bond originates at the chosen carbon center ----------
    _attachHydrogenToC2Visual(molEl, newCount) {
        const structure = molEl.querySelector('.molecule-structure');
        if (!structure) return;

        const info = molEl._internal || { c1pos: { x: 60, y: 120 }, c2pos: { x: 180, y: 120 }, hydrogens: [] };
        const bondType = molEl.dataset.bond || 'single';
        const count = newCount; // 1-based total attached

        // pick which carbon this hydrogen should attach to and the placement offset
        let attachTo = 'c1';
        let indexOnCarbon = 0;

        if (bondType === 'single') {
            // ethane: 6 H total -> 3 on c1 then 3 on c2
            const which = (count - 1) % 6; // 0..5
            if (which < 3) { attachTo = 'c1'; indexOnCarbon = which; } else { attachTo = 'c2'; indexOnCarbon = which - 3; }
        } else if (bondType === 'double') {
            // ethene: 4 H total -> 2 on c1 then 2 on c2
            const which = (count - 1) % 4; // 0..3
            if (which < 2) { attachTo = 'c1'; indexOnCarbon = which; } else { attachTo = 'c2'; indexOnCarbon = which - 2; }
        } else if (bondType === 'triple') {
            // ethyne: 2 H total -> 1 on c1 then 1 on c2
            const which = (count - 1) % 2;
            attachTo = (which === 0) ? 'c1' : 'c2';
            indexOnCarbon = 0;
        }

        // define offset positions relative to a carbon center depending on bond type
        const offsets = {
            single: [
                [{ x: -36, y: -40 }, { x: -70, y: 0 }, { x: -36, y: 40 }], // c1 positions
                [{ x: 36, y: -40 }, { x: 70, y: 0 }, { x: 36, y: 40 }]    // c2 positions
            ],
            double: [
                [{ x: -64, y: -20 }, { x: -64, y: 20 }], // c1 2 positions
                [{ x: 64, y: -20 }, { x: 64, y: 20 }]    // c2 2 positions
            ],
            triple: [
                [{ x: -100, y: 0 }], // c1 single position
                [{ x: 100, y: 0 }]   // c2 single position
            ]
        };

        // compute carbon base coordinate (within structure coordinate space)
        const base = (attachTo === 'c1') ? info.c1pos : info.c2pos;
        let offsetList;
        if (bondType === 'single') offsetList = offsets.single[(attachTo === 'c1') ? 0 : 1];
        else if (bondType === 'double') offsetList = offsets.double[(attachTo === 'c1') ? 0 : 1];
        else offsetList = offsets.triple[(attachTo === 'c1') ? 0 : 1];

        // choose offset for this index
        const off = offsetList[indexOnCarbon % offsetList.length];

        // actual target position within structure coords
        const target = { x: base.x + off.x, y: base.y + off.y };

        // create hydrogen node at carbon center, animate to target
        const hNode = document.createElement('div');
        hNode.className = 'atom hydrogen';
        hNode.textContent = 'H';
        hNode.style.position = 'absolute';
        // start at carbon center (so bond originates from carbon)
        const startX = base.x - 20, startY = base.y - 20;
        hNode.style.left = `${startX}px`;
        hNode.style.top = `${startY}px`;
        hNode.style.transform = 'scale(0.6)';
        hNode.style.transition = 'left 420ms cubic-bezier(.2,.9,.2,1), top 420ms cubic-bezier(.2,.9,.2,1), transform 420ms ease';
        structure.appendChild(hNode);

        // create bond element anchored at carbon center
        const bondEl = document.createElement('div');
        bondEl.className = 'bond live-bond';
        bondEl.style.position = 'absolute';
        bondEl.style.background = '#00ff88';
        bondEl.style.borderRadius = '2px';
        bondEl.style.height = '4px';
        bondEl.style.width = '2px'; // start small
        bondEl.style.left = `${base.x}px`;
        bondEl.style.top = `${base.y}px`;
        bondEl.style.transformOrigin = '0 50%';
        bondEl.style.opacity = '0.0';
        structure.appendChild(bondEl);

        // animate to target on next frame
        requestAnimationFrame(() => {
            hNode.style.left = `${target.x - 20}px`;
            hNode.style.top = `${target.y - 20}px`;
            hNode.style.transform = 'scale(1)';
            // update bond to span from carbon base to target
            const fromX = base.x, fromY = base.y;
            const toX = target.x, toY = target.y;
            const dx = toX - fromX, dy = toY - fromY;
            const len = Math.hypot(dx, dy);
            const ang = Math.atan2(dy, dx) * 180 / Math.PI;
            bondEl.style.left = `${Math.min(fromX, toX)}px`;
            bondEl.style.top = `${Math.min(fromY, toY)}px`;
            bondEl.style.width = `${len}px`;
            bondEl.style.transform = `translate(${fromX - Math.min(fromX, toX)}px, ${fromY - Math.min(fromY, toY)}px) rotate(${ang}deg)`;
            bondEl.style.opacity = '1.0';
        });

        if (!molEl._internal) molEl._internal = { hydrogens: [] };
        molEl._internal.hydrogens.push({ node: hNode, bond: bondEl });

        setTimeout(() => {
            hNode.style.transition = '';
            bondEl.style.transition = '';
            hNode.style.pointerEvents = 'none';
            bondEl.style.pointerEvents = 'none';
        }, 520);
    }

    // ---------- Molecule detection & creation (cluster-based) ----------
    checkForMoleculeFormation() {
        if (this.spawnedAtoms.length < 2) return;

        // compute centers
        const atomsWithCenters = this.spawnedAtoms.map(a => {
            const rect = a.element.getBoundingClientRect();
            return { atom: a, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
        });

        const threshold = 60; // overlap distance
        const n = atomsWithCenters.length;
        const adj = Array.from({ length: n }, () => []);

        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const dx = atomsWithCenters[i].cx - atomsWithCenters[j].cx;
                const dy = atomsWithCenters[i].cy - atomsWithCenters[j].cy;
                const d = Math.hypot(dx, dy);
                if (d < threshold) {
                    adj[i].push(j); adj[j].push(i);
                }
            }
        }

        const visited = new Array(n).fill(false);
        const clusters = [];

        for (let i = 0; i < n; i++) {
            if (visited[i]) continue;
            const stack = [i];
            const compIdx = [];
            visited[i] = true;
            while (stack.length) {
                const u = stack.pop();
                compIdx.push(u);
                for (const v of adj[u]) {
                    if (!visited[v]) { visited[v] = true; stack.push(v); }
                }
            }
            if (compIdx.length > 0) clusters.push(compIdx.map(idx => atomsWithCenters[idx]));
        }

        if (clusters.length === 0) return;

        const molecules = [
            { name: 'Propanol', formula: 'C₃H₈O', counts: { C: 3, H: 8, O: 1 } },
            { name: 'Propane', formula: 'C₃H₈', counts: { C: 3, H: 8, O: 0 } },
            { name: 'Acetone', formula: 'C₃H₆O', counts: { C: 3, H: 6, O: 1 } },
            { name: 'Ethanol', formula: 'C₂H₆O', counts: { C: 2, H: 6, O: 1 } },
            { name: 'Acetaldehyde', formula: 'C₂H₄O', counts: { C: 2, H: 4, O: 1 } },
            { name: 'Formaldehyde', formula: 'CH₂O', counts: { C: 1, H: 2, O: 1 } },
            { name: 'Methane', formula: 'CH₄', counts: { C: 1, H: 4, O: 0 } },
            { name: 'Carbon Dioxide', formula: 'CO₂', counts: { C: 1, H: 0, O: 2 } },
            { name: 'Water', formula: 'H₂O', counts: { C: 0, H: 2, O: 1 } }
        ];

        for (const cluster of clusters) {
            const counts = { C: 0, H: 0, O: 0 };
            for (const it of cluster) counts[it.atom.type]++;

            const centroid = {
                x: cluster.reduce((s, it) => s + it.cx, 0) / cluster.length,
                y: cluster.reduce((s, it) => s + it.cy, 0) / cluster.length
            };

            let formed = false;
            for (const mol of molecules) {
                const need = mol.counts;
                if (counts.C >= (need.C || 0) && counts.H >= (need.H || 0) && counts.O >= (need.O || 0)) {
                    const pickNearestFromCluster = (type, number) => {
                        if (number === 0) return [];
                        const candidates = cluster
                            .filter(it => it.atom.type === type)
                            .map(it => ({ item: it, d: Math.hypot(it.cx - centroid.x, it.cy - centroid.y) }))
                            .sort((a, b) => a.d - b.d)
                            .slice(0, number)
                            .map(x => x.item.atom);
                        return candidates.length === number ? candidates : null;
                    };

                    const selected = [];
                    let ok = true;
                    for (const t of ['C','H','O']) {
                        const needCount = need[t] || 0;
                        if (needCount > 0) {
                            const picked = pickNearestFromCluster(t, needCount);
                            if (!picked) { ok = false; break; }
                            selected.push(...picked);
                        }
                    }
                    if (!ok) continue;

                    // specialized snapping per molecule
                    if (mol.formula === 'CH₂O' || mol.formula === 'CH2O' || mol.name === 'Formaldehyde') {
                        this.animateFormaldehydeSnap(selected, centroid.x, centroid.y, mol.name, mol.formula);
                        formed = true; break;
                    }

                    if (mol.formula === 'CH₄' || mol.formula === 'CH4' || mol.name === 'Methane') {
                        this.animateMethaneSnap(selected, centroid.x, centroid.y, mol.name, mol.formula);
                        formed = true; break;
                    }

                    if (mol.formula === 'H₂O' || mol.formula === 'H2O' || mol.name === 'Water') {
                        this.animateWaterSnap(selected, centroid.x, centroid.y, mol.name, mol.formula);
                        formed = true; break;
                    }

                    if (mol.formula === 'CO₂' || mol.formula === 'CO2' || mol.name === 'Carbon Dioxide') {
                        this.animateCO2Snap(selected, centroid.x, centroid.y, mol.name, mol.formula);
                        formed = true; break;
                    }

                    // fallback
                    this.createMoleculeVisual(mol.name, mol.formula, selected, centroid.x, centroid.y);
                    formed = true; break;
                }
            }
            if (formed) {
                // next cluster
            }
        }
    }

    // ---------- Helpers for consistent coordinate math ----------
    _globalToContainerLocal(globalX, globalY) {
        const rect = this.moleculeContainer.getBoundingClientRect();
        return { x: globalX - rect.left, y: globalY - rect.top };
    }

    _placeAtomElementAt(el, localX, localY) {
        const half = 30; // half of 60px atom
        el.style.left = `${Math.max(0, Math.min(this.moleculeContainer.clientWidth - 60, localX - half))}px`;
        el.style.top = `${Math.max(0, Math.min(this.moleculeContainer.clientHeight - 60, localY - half))}px`;
    }

    // ---------- Formaldehyde snapping routine ----------
    animateFormaldehydeSnap(atomsUsed, centerX, centerY, name, formula) {
        const cAtom = atomsUsed.find(a => a.type === 'C');
        const oAtom = atomsUsed.find(a => a.type === 'O');
        const hAtoms = atomsUsed.filter(a => a.type === 'H');
        if (!cAtom || !oAtom || hAtoms.length < 2) { this.updateStatus('Formaldehyde requires 1 C, 2 H, 1 O'); return; }

        const allToAnimate = [cAtom, oAtom, hAtoms[0], hAtoms[1]];

        const containerRect = this.moleculeContainer.getBoundingClientRect();
        const carbonCenter = this._globalToContainerLocal(centerX, centerY); // center in local coords

        const radius = 80;
        const angles = [0, 120, -120]; // O, H1, H2

        // compute target centers (local)
        const targets = angles.map(a => {
            const r = a * Math.PI / 180;
            return { x: carbonCenter.x + Math.cos(r) * radius, y: carbonCenter.y + Math.sin(r) * radius };
        });

        // animate DOM elements to targets (position atoms by center)
        allToAnimate.forEach(item => {
            if (item.element.parentNode !== this.moleculeContainer) this.moleculeContainer.appendChild(item.element);
            item.element.style.transition = 'left 520ms cubic-bezier(.2,.9,.2,1), top 520ms cubic-bezier(.2,.9,.2,1), transform 520ms ease';
            item.element.style.zIndex = 2000;
            const atomInner = item.element.querySelector('.atom'); if (atomInner) { atomInner.style.transition = 'transform 520ms ease'; atomInner.style.transform = 'scale(1.12)'; }
        });

        this._placeAtomElementAt(cAtom.element, carbonCenter.x, carbonCenter.y);
        this._placeAtomElementAt(oAtom.element, targets[0].x, targets[0].y);
        this._placeAtomElementAt(hAtoms[0].element, targets[1].x, targets[1].y);
        this._placeAtomElementAt(hAtoms[1].element, targets[2].x, targets[2].y);

        const bonds = [];
        const makeTempBond = (from, to, double = false) => {
            const bond = document.createElement('div'); bond.className = 'bond temp-bond';
            bond.style.position = 'absolute';
            const fromX = from.x, fromY = from.y, toX = to.x, toY = to.y;
            const dx = toX - fromX, dy = toY - fromY; const len = Math.hypot(dx, dy); const angle = Math.atan2(dy, dx) * 180 / Math.PI;
            bond.style.left = `${Math.min(fromX, toX)}px`;
            bond.style.top = `${Math.min(fromY, toY)}px`;
            bond.style.width = `${len}px`;
            bond.style.height = '4px';
            bond.style.transformOrigin = '0 50%';
            bond.style.transform = `translate(${fromX - Math.min(fromX, toX)}px, ${fromY - Math.min(fromY, toY)}px) rotate(${angle}deg)`;
            bond.style.background = '#00ff88'; bond.style.borderRadius = '2px'; bond.style.opacity = '0.95';
            this.moleculeContainer.appendChild(bond);
            bonds.push(bond);
            if (double) {
                const offset = 6;
                const nx = -dy / (len || 1);
                const ny = dx / (len || 1);
                const bond2 = bond.cloneNode();
                bond2.style.transform = `translate(${fromX - Math.min(fromX, toX) + nx * offset}px, ${fromY - Math.min(fromY, toY) + ny * offset}px) rotate(${angle}deg)`;
                this.moleculeContainer.appendChild(bond2);
                bonds.push(bond2);
            }
        };

        const carbonPos = carbonCenter;
        makeTempBond(carbonPos, targets[0], true);
        makeTempBond(carbonPos, targets[1], false);
        makeTempBond(carbonPos, targets[2], false);

        setTimeout(() => {
            this.removeAtoms(allToAnimate);
            bonds.forEach(b => b.remove());
            const moleculeEl = this.createMoleculeVisual(name, formula, [], centerX, centerY, { style: 'hcho-detailed' });
            this.updateStatus('Formaldehyde formed — trigonal planar (∼120°)');
        }, 580);
    }

    // ---------- Methane (CH4) snapping + visual (tetrahedral projection) ----------
    animateMethaneSnap(atomsUsed, centerX, centerY, name, formula) {
        const cAtom = atomsUsed.find(a => a.type === 'C');
        const hAtoms = atomsUsed.filter(a => a.type === 'H');
        if (!cAtom || hAtoms.length < 4) { this.updateStatus('Methane requires 1 C and 4 H'); return; }

        const allToAnimate = [cAtom, ...hAtoms.slice(0,4)];
        const carbonCenter = this._globalToContainerLocal(centerX, centerY);
        const radius = 75;

        const proj = [
            { x: 0, y: -1 },
            { x: 0.94, y: 0.33 },
            { x: -0.94, y: 0.33 },
            { x: 0, y: 0.9 }
        ];

        const targets = proj.map(p => ({ x: carbonCenter.x + p.x * radius, y: carbonCenter.y + p.y * radius }));

        allToAnimate.forEach(item => { if (item.element.parentNode !== this.moleculeContainer) this.moleculeContainer.appendChild(item.element); item.element.style.transition='left 520ms cubic-bezier(.2,.9,.2,1), top 520ms cubic-bezier(.2,.9,.2,1)'; item.element.style.zIndex=2000; });

        this._placeAtomElementAt(cAtom.element, carbonCenter.x, carbonCenter.y);
        for (let i=0;i<4;i++) this._placeAtomElementAt(hAtoms[i].element, targets[i].x, targets[i].y);

        const bonds = [];
        const makeBondLocal = (x1,y1,x2,y2, double=false) => {
            const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx,dy), ang = Math.atan2(dy,dx)*180/Math.PI;
            const left = Math.min(x1, x2), top = Math.min(y1, y2);
            const bond = document.createElement('div');
            bond.className = 'bond';
            bond.style.position = 'absolute';
            bond.style.left = `${left}px`;
            bond.style.top = `${top}px`;
            bond.style.width = `${len}px`;
            bond.style.height = '4px';
            bond.style.transformOrigin = '0 50%';
            bond.style.transform = `translate(${x1 - left}px, ${y1 - top}px) rotate(${ang}deg)`;
            bond.style.background = '#00ff88';
            bond.style.borderRadius = '2px';
            this.moleculeContainer.appendChild(bond);
            bonds.push(bond);
            if (double) {
                const offset = 6;
                const nx = -dy / (len || 1);
                const ny = dx / (len || 1);
                const b2 = bond.cloneNode();
                b2.style.transform = `translate(${x1 - left + nx*offset}px, ${y1 - top + ny*offset}px) rotate(${ang}deg)`;
                this.moleculeContainer.appendChild(b2);
                bonds.push(b2);
            }
        };

        targets.forEach(t => makeBondLocal(carbonCenter.x, carbonCenter.y, t.x, t.y));

        setTimeout(()=>{
            this.removeAtoms(allToAnimate);
            bonds.forEach(b=>b.remove());
            const moleculeEl = this.createMoleculeVisual(name, formula, [], centerX, centerY, { style: 'ch4-detailed' });
            this.updateStatus('Methane formed — tetrahedral (projected)');
        }, 580);
    }

    // ---------- Water (H2O) snapping + visual (bent ~104.5°) ----------
    animateWaterSnap(atomsUsed, centerX, centerY, name, formula) {
        const oAtom = atomsUsed.find(a=>a.type==='O');
        const hAtoms = atomsUsed.filter(a=>a.type==='H');
        if (!oAtom || hAtoms.length < 2) { this.updateStatus('Water requires 1 O and 2 H'); return; }

        const allToAnimate = [oAtom, hAtoms[0], hAtoms[1]];
        const oCenter = this._globalToContainerLocal(centerX, centerY);
        const radius = 75;
        const halfAngle = 104.5/2 * Math.PI/180;
        const targets = [
            { x: oCenter.x + Math.cos(halfAngle) * radius, y: oCenter.y - Math.sin(halfAngle) * radius },
            { x: oCenter.x - Math.cos(halfAngle) * radius, y: oCenter.y - Math.sin(halfAngle) * radius }
        ];

        allToAnimate.forEach(item=>{ if (item.element.parentNode !== this.moleculeContainer) this.moleculeContainer.appendChild(item.element); item.element.style.transition='left 520ms cubic-bezier(.2,.9,.2,1), top 520ms cubic-bezier(.2,.9,.2,1)'; item.element.style.zIndex=2000; });

        this._placeAtomElementAt(oAtom.element, oCenter.x, oCenter.y);
        this._placeAtomElementAt(hAtoms[0].element, targets[0].x, targets[0].y);
        this._placeAtomElementAt(hAtoms[1].element, targets[1].x, targets[1].y);

        const bonds = [];
        const makeBondLocal = (x1,y1,x2,y2, double=false) => {
            const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx,dy), ang = Math.atan2(dy,dx)*180/Math.PI;
            const left = Math.min(x1, x2), top = Math.min(y1, y2);
            const bond = document.createElement('div');
            bond.className = 'bond';
            bond.style.position = 'absolute';
            bond.style.left = `${left}px`;
            bond.style.top = `${top}px`;
            bond.style.width = `${len}px`;
            bond.style.height = '4px';
            bond.style.transformOrigin = '0 50%';
            bond.style.transform = `translate(${x1 - left}px, ${y1 - top}px) rotate(${ang}deg)`;
            bond.style.background = '#00ff88';
            bond.style.borderRadius = '2px';
            this.moleculeContainer.appendChild(bond);
            bonds.push(bond);
            if (double) {
                const offset = 6;
                const nx = -dy / (len || 1);
                const ny = dx / (len || 1);
                const b2 = bond.cloneNode();
                b2.style.transform = `translate(${x1 - left + nx*offset}px, ${y1 - top + ny*offset}px) rotate(${ang}deg)`;
                this.moleculeContainer.appendChild(b2);
                bonds.push(b2);
            }
        };

        makeBondLocal(oCenter.x, oCenter.y, targets[0].x, targets[0].y);
        makeBondLocal(oCenter.x, oCenter.y, targets[1].x, targets[1].y);

        setTimeout(()=>{
            this.removeAtoms(allToAnimate);
            bonds.forEach(b=>b.remove());
            const molEl = this.createMoleculeVisual(name, formula, [], centerX, centerY, { style: 'h2o-detailed' });
            this.updateStatus('Water formed — bent (~104.5°)');
        }, 580);
    }

    // ---------- Carbon dioxide (CO2) snapping + visual (linear) ----------
    animateCO2Snap(atomsUsed, centerX, centerY, name, formula) {
        const cAtom = atomsUsed.find(a=>a.type==='C');
        const oAtoms = atomsUsed.filter(a=>a.type==='O');
        if (!cAtom || oAtoms.length < 2) { this.updateStatus('CO2 requires 1 C and 2 O'); return; }

        const allToAnimate = [cAtom, oAtoms[0], oAtoms[1]];
        const carbonCenter = this._globalToContainerLocal(centerX, centerY);
        const radius = 100;
        const targets = [ { x: carbonCenter.x - radius, y: carbonCenter.y }, { x: carbonCenter.x + radius, y: carbonCenter.y } ];

        allToAnimate.forEach(item=>{ if (item.element.parentNode !== this.moleculeContainer) this.moleculeContainer.appendChild(item.element); item.element.style.transition='left 520ms cubic-bezier(.2,.9,.2,1), top 520ms cubic-bezier(.2,.9,.2,1)'; item.element.style.zIndex=2000; });

        this._placeAtomElementAt(cAtom.element, carbonCenter.x, carbonCenter.y);
        this._placeAtomElementAt(oAtoms[0].element, targets[0].x, targets[0].y);
        this._placeAtomElementAt(oAtoms[1].element, targets[1].x, targets[1].y);

        const bonds = [];
        const makeDoubleBond = (from, to) => {
            const fromX = from.x, fromY = from.y, toX = to.x, toY = to.y;
            const dx = toX - fromX, dy = toY - fromY;
            const len = Math.hypot(dx, dy);
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;
            const offset = 6;
            const nx = -dy / (len || 1);
            const ny = dx / (len || 1);
            const left = Math.min(fromX, toX);
            const top = Math.min(fromY, toY);
            const baseTransform = (ox = 0, oy = 0) => `translate(${fromX - left + ox}px, ${fromY - top + oy}px) rotate(${angle}deg)`;
            const b1 = document.createElement('div'); b1.className='bond'; b1.style.position='absolute'; b1.style.left = `${left}px`; b1.style.top = `${top}px`; b1.style.width = `${len}px`; b1.style.height = '4px'; b1.style.transformOrigin = '0 50%'; b1.style.transform = baseTransform(0,0); b1.style.background = '#00ff88'; b1.style.borderRadius = '2px';
            this.moleculeContainer.appendChild(b1); bonds.push(b1);
            const b2 = document.createElement('div'); b2.className='bond'; b2.style.position='absolute'; b2.style.left = `${left}px`; b2.style.top = `${top}px`; b2.style.width = `${len}px`; b2.style.height = '4px'; b2.style.transformOrigin = '0 50%'; b2.style.transform = baseTransform(nx * offset, ny * offset); b2.style.background = '#00ff88'; b2.style.borderRadius = '2px';
            this.moleculeContainer.appendChild(b2); bonds.push(b2);
        };

        makeDoubleBond(carbonCenter, targets[0]);
        makeDoubleBond(carbonCenter, targets[1]);

        setTimeout(()=> {
            this.removeAtoms(allToAnimate);
            bonds.forEach(b=>b.remove());
            const molEl = this.createMoleculeVisual(name, formula, [], centerX, centerY, { style: 'co2-detailed' });
            this.updateStatus('Carbon dioxide formed — linear (180°)');
        }, 580);
    }

    // ---------- createMoleculeVisual (final) ----------
    createMoleculeVisual(name, formula, atomsUsed, centerX, centerY, opts = {}) {
        this.addDiscoveredMolecule(name, formula);

        const molecule = document.createElement('div'); molecule.className = 'molecule';
        molecule.innerHTML = `<div class="molecule-title">${name} - ${formula}</div><div class="molecule-structure"></div>`;
        molecule.style.position = 'absolute';

        const width = 240, height = 240;
        molecule.style.width = `${width}px`; molecule.style.height = `${height}px`;

        const containerRect = this.moleculeContainer.getBoundingClientRect();
        const relLeft = Math.max(0, Math.min(containerRect.width - width, centerX - containerRect.left - width / 2));
        const relTop  = Math.max(0, Math.min(containerRect.height - height, centerY - containerRect.top - height / 2));
        molecule.style.left = `${relLeft}px`;
        molecule.style.top = `${relTop}px`;

        const structure = molecule.querySelector('.molecule-structure');

        structure.style.position = 'absolute';
        structure.style.left = '50%';
        structure.style.top = '50%';
        structure.style.transform = 'translate(-50%,-50%)';
        structure.style.width = `${width}px`;
        structure.style.height = `${height}px`;
        structure.style.boxSizing = 'border-box';
        structure.style.pointerEvents = 'none';

        const titleEl = molecule.querySelector('.molecule-title');
        if (titleEl) {
            titleEl.style.position = 'absolute';
            titleEl.style.top = '10px';
            titleEl.style.left = '50%';
            titleEl.style.transform = 'translateX(-50%)';
            titleEl.style.pointerEvents = 'auto';
            titleEl.style.zIndex = '10';
        }

        // draw different final visuals based on opts.style or formula (reuse implementations above)
        if (opts.style === 'hcho-detailed' || formula === 'CH₂O' || formula === 'CH2O') {
            // (same as earlier detailed block)
            const cx = width/2, cy = height/2, r = 70;
            const makeNode = (cls,label,x,y)=>{ const n=document.createElement('div'); n.className=`atom ${cls}`; n.textContent=label; n.style.position='absolute'; n.style.left=`${x - (cls==='hydrogen'?20:28)}px`; n.style.top=`${y - (cls==='hydrogen'?20:28)}px`; return n; };
            const cNode = makeNode('carbon','C', cx, cy);
            const oNode = makeNode('oxygen','O', cx + r, cy);
            const a1 = 120*Math.PI/180, a2 = -120*Math.PI/180;
            const h1 = makeNode('hydrogen','H', cx + Math.cos(a1)*r, cy + Math.sin(a1)*r);
            const h2 = makeNode('hydrogen','H', cx + Math.cos(a2)*r, cy + Math.sin(a2)*r);
            const makeBond = (x1,y1,x2,y2,double=false)=>{ const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy), ang = Math.atan2(dy,dx)*180/Math.PI; const b=document.createElement('div'); b.style.position='absolute'; b.style.left=`${x1}px`; b.style.top=`${y1}px`; b.style.width=`${len}px`; b.style.height='4px'; b.style.transformOrigin='0 50%'; b.style.transform=`rotate(${ang}deg)`; b.style.background='#00ff88'; b.style.borderRadius='2px'; if (double){ const b2=b.cloneNode(); const nx = -dy/(len||1), ny = dx/(len||1), offset=6; b2.style.transform = `translate(${nx*offset}px, ${ny*offset}px) rotate(${ang}deg)`; return [b,b2]; } return [b]; };
            const bonds = [];
            bonds.push(...makeBond(cx,cy, cx + r, cy, true));
            bonds.push(...makeBond(cx,cy, cx + Math.cos(a1)*r, cy + Math.sin(a1)*r));
            bonds.push(...makeBond(cx,cy, cx + Math.cos(a2)*r, cy + Math.sin(a2)*r));
            bonds.forEach(b=>structure.appendChild(b)); structure.appendChild(cNode); structure.appendChild(oNode); structure.appendChild(h1); structure.appendChild(h2);
        }
        else if (opts.style === 'ch4-detailed' || formula === 'CH₄' || formula === 'CH4') {
            const cx = width/2, cy = height/2, r = 70;
            const proj = [ {x:0,y:-1}, {x:0.94,y:0.33}, {x:-0.94,y:0.33}, {x:0,y:0.9} ];
            const makeNode = (cls,label,centerX,centerY) => {
                const n = document.createElement('div');
                n.className = `atom ${cls}`;
                n.textContent = label;
                n.style.position = 'absolute';
                const size = (cls === 'hydrogen') ? 40 : 55;
                n.style.left = `${centerX - size/2}px`;
                n.style.top  = `${centerY - size/2}px`;
                return n;
            };
            const makeBond = (x1,y1,x2,y2, double=false) => {
                const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx,dy), ang = Math.atan2(dy,dx)*180/Math.PI;
                const left = Math.min(x1, x2), top = Math.min(y1, y2);
                const b = document.createElement('div');
                b.className = 'bond';
                b.style.position = 'absolute';
                b.style.left = `${left}px`;
                b.style.top = `${top}px`;
                b.style.width = `${len}px`;
                b.style.height = '4px';
                b.style.transformOrigin = '0 50%';
                b.style.transform = `translate(${x1 - left}px, ${y1 - top}px) rotate(${ang}deg)`;
                b.style.background = '#00ff88';
                b.style.borderRadius = '2px';
                structure.appendChild(b);
                if (double) {
                    const offset = 6;
                    const nx = -dy / (len || 1);
                    const ny = dx / (len || 1);
                    const b2 = b.cloneNode();
                    b2.style.transform = `translate(${x1 - left + nx*offset}px, ${y1 - top + ny*offset}px) rotate(${ang}deg)`;
                    structure.appendChild(b2);
                }
                return b;
            };

            const cNode = makeNode('carbon','C', cx, cy);
            const hNodes = proj.map(p => makeNode('hydrogen','H', cx + p.x * r, cy + p.y * r));

            hNodes.forEach(hn => {
                const hx = parseFloat(hn.style.left) + 20; // hydrogen size/2 = 20
                const hy = parseFloat(hn.style.top) + 20;
                makeBond(cx, cy, hx, hy);
            });

            structure.appendChild(cNode);
            hNodes.forEach(hn => structure.appendChild(hn));
        }
        else if (opts.style === 'h2o-detailed' || formula === 'H₂O' || formula === 'H2O') {
            const cx = width/2, cy = height/2, r = 70;
            const halfAngle = 104.5/2 * Math.PI/180;
            const makeNode = (cls,label,centerX,centerY) => {
                const n = document.createElement('div');
                n.className = `atom ${cls}`;
                n.textContent = label;
                n.style.position = 'absolute';
                const size = (cls === 'hydrogen') ? 40 : 55;
                n.style.left = `${centerX - size/2}px`;
                n.style.top  = `${centerY - size/2}px`;
                return n;
            };

            const oNode = makeNode('oxygen','O', cx, cy);
            const h1x = cx + Math.cos(halfAngle) * r, h1y = cy - Math.sin(halfAngle) * r;
            const h2x = cx - Math.cos(halfAngle) * r, h2y = cy - Math.sin(halfAngle) * r;
            const h1Node = makeNode('hydrogen','H', h1x, h1y);
            const h2Node = makeNode('hydrogen','H', h2x, h2y);

            const makeBond = (x1,y1,x2,y2, double=false) => {
                const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx,dy), ang = Math.atan2(dy,dx)*180/Math.PI;
                const left = Math.min(x1, x2), top = Math.min(y1, y2);
                const b = document.createElement('div');
                b.className = 'bond';
                b.style.position = 'absolute';
                b.style.left = `${left}px`;
                b.style.top = `${top}px`;
                b.style.width = `${len}px`;
                b.style.height = '4px';
                b.style.transformOrigin = '0 50%';
                b.style.transform = `translate(${x1 - left}px, ${y1 - top}px) rotate(${ang}deg)`;
                b.style.background = '#00ff88';
                b.style.borderRadius = '2px';
                structure.appendChild(b);
                if (double) {
                    const offset = 6;
                    const nx = -dy / (len || 1);
                    const ny = dx / (len || 1);
                    const b2 = b.cloneNode();
                    b2.style.transform = `translate(${x1 - left + nx*offset}px, ${y1 - top + ny*offset}px) rotate(${ang}deg)`;
                    structure.appendChild(b2);
                }
            };

            makeBond(cx, cy, h1x, h1y);
            makeBond(cx, cy, h2x, h2y);

            structure.appendChild(oNode);
            structure.appendChild(h1Node);
            structure.appendChild(h2Node);
        }
        else if (opts.style === 'c3h6-detailed' || formula === 'C₃H₆' || formula === 'C3H6') {
            const cx = width/2, cy = height/2, r = 72;
            const angles = [-90, 30, 150];
            const makeNode = (cls,label,x,y)=>{ const n=document.createElement('div'); n.className=`atom ${cls}`; n.textContent=label; n.style.position='absolute'; const size=(cls==='hydrogen')?40:55; n.style.left=`${x - size/2}px`; n.style.top=`${y - size/2}px`; return n; };
            const positions = angles.map(a=>{ const rad = a * Math.PI / 180; return { x: cx + Math.cos(rad)*r, y: cy + Math.sin(rad)*r }; });
            const makeBond = (x1,y1,x2,y2)=>{ const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI; const left=Math.min(x1,x2), top=Math.min(y1,y2); const b=document.createElement('div'); b.className='bond'; b.style.position='absolute'; b.style.left=`${left}px`; b.style.top=`${top}px`; b.style.width=`${len}px`; b.style.height='4px'; b.style.transformOrigin='0 50%'; b.style.transform = `translate(${x1-left}px, ${y1-top}px) rotate(${ang}deg)`; b.style.background='#00ff88'; b.style.borderRadius='2px'; return b; };
            structure.appendChild(makeBond(positions[0].x,positions[0].y, positions[1].x,positions[1].y));
            structure.appendChild(makeBond(positions[1].x,positions[1].y, positions[2].x,positions[2].y));
            structure.appendChild(makeBond(positions[2].x,positions[2].y, positions[0].x,positions[0].y));
            structure.appendChild(makeNode('carbon','C', positions[0].x, positions[0].y));
            structure.appendChild(makeNode('carbon','C', positions[1].x, positions[1].y));
            structure.appendChild(makeNode('carbon','C', positions[2].x, positions[2].y));
            // approximate H positions (two per carbon)
            positions.forEach(p => {
                const h1 = { x: p.x + (p.x - cx) * 0.5 + 18, y: p.y + (p.y - cy) * 0.5 + 6 };
                const h2 = { x: p.x + (p.x - cx) * 0.5 - 18, y: p.y + (p.y - cy) * 0.5 - 6 };
                structure.appendChild(makeNode('hydrogen','H', h1.x, h1.y));
                structure.appendChild(makeNode('hydrogen','H', h2.x, h2.y));
            });
        }
        //else if (opts.style === 'co2-detailed' || formula === 'CO₂' || formula === 'CO2') {
           // const cx = width/2, cy = height/2, r = 80;
            //const makeNode=(cls,label,x,y)=>{ const n=document.createElement('div'); n.className=`atom ${cls}`; n.textContent=label; n.style.position='absolute'; n.style.left=`${x - (cls==='oxygen'?28:28)}px`; n.style.top=`${y - (cls==='oxygen'?28:28)}px`; return n; };
        else if (opts.style === 'co2-detailed' || formula === 'CO₂' || formula === 'CO2') {
            const cx = width/2, cy = height/2, r = 80;
            const makeNode=(cls,label,x,y)=>{ const n=document.createElement('div'); n.className=`atom ${cls}`; n.textContent=label; n.style.position='absolute'; n.style.left=`${x - (cls==='oxygen'?28:28)}px`; n.style.top=`${y - (cls==='oxygen'?28:28)}px`; return n; };
            const cNode = makeNode('carbon','C', cx, cy);
            const oL = makeNode('oxygen','O', cx - r, cy); const oR = makeNode('oxygen','O', cx + r, cy);

            const makeParallelBonds = (x1,y1,x2,y2) => {
                const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx,dy), ang = Math.atan2(dy,dx)*180/Math.PI;
                const offset = 6;
                const nx = -dy/(len||1), ny = dx/(len||1);
                const left = Math.min(x1, x2), top = Math.min(y1, y2);
                const baseTransform = (ox=0, oy=0) => `translate(${x1 - left + ox}px, ${y1 - top + oy}px) rotate(${ang}deg)`;
                const b1 = document.createElement('div'); b1.className='bond'; b1.style.position='absolute'; b1.style.left = `${left}px`; b1.style.top = `${top}px`; b1.style.width = `${len}px`; b1.style.height = '4px'; b1.style.transformOrigin='0 50%'; b1.style.transform = baseTransform(0,0); b1.style.background='#00ff88'; b1.style.borderRadius='2px';
                const b2 = document.createElement('div'); b2.className='bond'; b2.style.position='absolute'; b2.style.left = `${left}px`; b2.style.top = `${top}px`; b2.style.width = `${len}px`; b2.style.height = '4px'; b2.style.transformOrigin='0 50%'; b2.style.transform = baseTransform(nx*offset, ny*offset); b2.style.background='#00ff88'; b2.style.borderRadius='2px';
                return [b1,b2];
            };

            const bonds = [];
            bonds.push(...makeParallelBonds(cx,cy, cx - r, cy));
            bonds.push(...makeParallelBonds(cx,cy, cx + r, cy));
            bonds.forEach(b => structure.appendChild(b));
            structure.appendChild(oL); structure.appendChild(cNode); structure.appendChild(oR);
        }
        else if (opts.style === 'c2single-detailed' || (formula === 'C2H6')) {
            const cx = width/2, cy = height/2;
            const c1x = cx - 40, c2x = cx + 40;
            const makeNode = (cls,label,x,y)=>{ const n=document.createElement('div'); n.className=`atom ${cls}`; n.textContent=label; n.style.position='absolute'; n.style.left=`${x - (cls==='hydrogen'?20:28)}px`; n.style.top=`${y - (cls==='hydrogen'?20:28)}px`; return n; };
            const c1 = makeNode('carbon','C', c1x, cy); const c2 = makeNode('carbon','C', c2x, cy);
            const hOffsetsLeft = [{x:-36,y:-30},{x:-56,y:6},{x:-36,y:36}];
            const hOffsetsRight = [{x:36,y:-30},{x:56,y:6},{x:36,y:36}];
            const makeBond = (x1,y1,x2,y2)=>{ const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy),ang=Math.atan2(dy,dx)*180/Math.PI; const left=Math.min(x1,x2),top=Math.min(y1,y2); const b=document.createElement('div'); b.className='bond'; b.style.position='absolute'; b.style.left=`${left}px`; b.style.top=`${top}px`; b.style.width=`${len}px`; b.style.height='4px'; b.style.transformOrigin='0 50%'; b.style.transform=`translate(${x1-left}px, ${y1-top}px) rotate(${ang}deg)`; b.style.background='#00ff88'; b.style.borderRadius='2px'; return b; };
            structure.appendChild(c1); structure.appendChild(c2);
            structure.appendChild(makeBond(c1x,cy,c2x,cy));
            hOffsetsLeft.forEach(o=>{ const hx=c1x+o.x, hy=cy+o.y; const hn=makeNode('hydrogen','H',hx,hy); structure.appendChild(makeBond(c1x,cy,hx,hy)); structure.appendChild(hn); });
            hOffsetsRight.forEach(o=>{ const hx=c2x+o.x, hy=cy+o.y; const hn=makeNode('hydrogen','H',hx,hy); structure.appendChild(makeBond(c2x,cy,hx,hy)); structure.appendChild(hn); });
        }
        else if (opts.style === 'c2h4-detailed' || (formula === 'C2H4')) {
            const cx = width/2, cy = height/2;
            const c1x = cx - 40, c2x = cx + 40;
            const makeNode = (cls,label,x,y)=>{ const n=document.createElement('div'); n.className=`atom ${cls}`; n.textContent=label; n.style.position='absolute'; n.style.left=`${x - (cls==='hydrogen'?20:28)}px`; n.style.top=`${y - (cls==='hydrogen'?20:28)}px`; return n; };
            const c1 = makeNode('carbon','C', c1x, cy); const c2 = makeNode('carbon','C', c2x, cy);
            const makeDouble = (x1,y1,x2,y2)=>{ const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI; const offset=6; const nx=-dy/(len||1), ny=dx/(len||1); const left=Math.min(x1,x2), top=Math.min(y1,y2); const b1=document.createElement('div'); b1.className='bond'; b1.style.position='absolute'; b1.style.left=`${left}px`; b1.style.top=`${top}px`; b1.style.width=`${len}px`; b1.style.height='4px'; b1.style.transformOrigin='0 50%'; b1.style.transform=`translate(${x1-left}px, ${y1-top}px) rotate(${ang}deg)`; b1.style.background='#00ff88'; b1.style.borderRadius='2px'; const b2=b1.cloneNode(); b2.style.transform = `translate(${x1-left + nx*offset}px, ${y1-top + ny*offset}px) rotate(${ang}deg)`; return [b1,b2]; };
            structure.appendChild(c1); structure.appendChild(c2);
            makeDouble(c1x,cy,c2x,cy).forEach(b=>structure.appendChild(b));
            const h1=makeNode('hydrogen','H',c1x-48,cy-24); const h2=makeNode('hydrogen','H',c1x-48,cy+24);
            const h3=makeNode('hydrogen','H',c2x+48,cy-24); const h4=makeNode('hydrogen','H',c2x+48,cy+24);
            const makeBondSimple=(x1,y1,x2,y2)=>{ const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy),ang=Math.atan2(dy,dx)*180/Math.PI; const left=Math.min(x1,x2), top=Math.min(y1,y2); const b=document.createElement('div'); b.className='bond'; b.style.position='absolute'; b.style.left=`${left}px`; b.style.top=`${top}px`; b.style.width=`${len}px`; b.style.height='4px'; b.style.transformOrigin='0 50%'; b.style.transform=`translate(${x1-left}px, ${y1-top}px) rotate(${ang}deg)`; b.style.background='#00ff88'; b.style.borderRadius='2px'; return b; };
            structure.appendChild(makeBondSimple(c1x,cy,c1x-48,cy-24)); structure.appendChild(h1);
            structure.appendChild(makeBondSimple(c1x,cy,c1x-48,cy+24)); structure.appendChild(h2);
            structure.appendChild(makeBondSimple(c2x,cy,c2x+48,cy-24)); structure.appendChild(h3);
            structure.appendChild(makeBondSimple(c2x,cy,c2x+48,cy+24)); structure.appendChild(h4);
        }
        else if (opts.style === 'c2h2-detailed' || (formula === 'C2H2')) {
            const cx = width/2, cy = height/2;
            const c1x = cx - 48, c2x = cx + 48;
            const makeNode = (cls,label,x,y)=>{ const n=document.createElement('div'); n.className=`atom ${cls}`; n.textContent=label; n.style.position='absolute'; n.style.left=`${x - (cls==='hydrogen'?20:28)}px`; n.style.top=`${y - (cls==='hydrogen'?20:28)}px`; return n; };
            const c1 = makeNode('carbon','C', c1x, cy); const c2 = makeNode('carbon','C', c2x, cy);
            const drawTriple = (x1,y1,x2,y2)=>{ const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI; const left=Math.min(x1,x2), top=Math.min(y1,y2); const b0=document.createElement('div'); b0.className='bond'; b0.style.position='absolute'; b0.style.left=`${left}px`; b0.style.top=`${top}px`; b0.style.width=`${len}px`; b0.style.height='4px'; b0.style.transformOrigin='0 50%'; b0.style.transform=`translate(${x1-left}px, ${y1-top}px) rotate(${ang}deg)`; b0.style.background='#00ff88'; b0.style.borderRadius='2px'; const offset=8; const nx=-dy/(len||1), ny=dx/(len||1); const b1=b0.cloneNode(); b1.style.transform=`translate(${x1-left + nx*offset}px, ${y1-top + ny*offset}px) rotate(${ang}deg)`; const b2=b0.cloneNode(); b2.style.transform=`translate(${x1-left - nx*offset}px, ${y1-top - ny*offset}px) rotate(${ang}deg)`; return [b0,b1,b2]; };
            structure.appendChild(c1); structure.appendChild(c2);
            drawTriple(c1x,cy,c2x,cy).forEach(b=>structure.appendChild(b));
            const h1=makeNode('hydrogen','H',c1x-80,cy); const h2=makeNode('hydrogen','H',c2x+80,cy);
            const makeBondSimple=(x1,y1,x2,y2)=>{ const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy),ang=Math.atan2(dy,dx)*180/Math.PI; const left=Math.min(x1,x2), top=Math.min(y1,y2); const b=document.createElement('div'); b.className='bond'; b.style.position='absolute'; b.style.left=`${left}px`; b.style.top=`${top}px`; b.style.width=`${len}px`; b.style.height='4px'; b.style.transformOrigin='0 50%'; b.style.transform=`translate(${x1-left}px, ${y1-top}px) rotate(${ang}deg)`; b.style.background='#00ff88'; b.style.borderRadius='2px'; return b; };
            structure.appendChild(makeBondSimple(c1x,cy,c1x-80,cy)); structure.appendChild(h1);
            structure.appendChild(makeBondSimple(c2x,cy,c2x+80,cy)); structure.appendChild(h2);
        }
        else {
            structure.style.display='flex'; structure.style.alignItems='center'; structure.style.justifyContent='center'; structure.style.gap='10px'; structure.innerHTML = `<div style="color:#fff;font-weight:700">${formula}</div>`;
        }

        this.moleculeContainer.appendChild(molecule);
        return molecule;
    }

    removeAtoms(atoms) {
        atoms.forEach(item => {
            try {
                if (item.element) {
                    item.element.classList.remove('dragging');
                    item.element.style.pointerEvents = '';
                    item.element.style.cursor = '';
                }
            } catch (e) { /* ignore */ }

            const idx = this.spawnedAtoms.findIndex(s => s === item || s.id === item.id || s.element === item.element);
            if (idx !== -1) this.spawnedAtoms.splice(idx, 1);
            if (item.element && item.element.parentNode) item.element.remove();
        });

        if (this.draggedElement && atoms.includes(this.draggedElement)) {
            this.draggedElement = null;
            this.isDragging = false;
            this.isPinching = false;
        }
    }

    addDiscoveredMolecule(name, formula) {
        if (!this.discoveredMolecules.find(m => m.formula === formula)) {
            this.discoveredMolecules.push({ name, formula });

            const item = document.createElement('div');
            item.className = 'discovered-item';
            item.innerHTML = `
                <div class="molecule-name">${name}</div>
                <div class="molecule-formula">${formula}</div>
            `;

            this.discoveredList.appendChild(item);
            this.updateDiscoveredList();
        }
    }

    updateDiscoveredList() {
        if (this.discoveredMolecules.length === 0) {
            this.discoveredList.innerHTML = '<div class="empty-state">No molecules discovered yet</div>';
        }
    }

    updateStatus(message) {
        if (this.status) {
            this.status.textContent = message;
        }
    }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
    new ARChemistryApp();
});    
