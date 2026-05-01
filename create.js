<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Room | naqd</title>
    <style>
        :root {
            --primary: #3b82f6;
            --bg: #f8fafc;
            --card: #ffffff;
            --text: #1e293b;
            --muted: #64748b;
            --radius: 12px;
            --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
        body { background: var(--bg); color: var(--text); padding: 40px 20px; display: flex; justify-content: center; }
        .container { width: 100%; max-width: 450px; background: var(--card); padding: 40px; border-radius: var(--radius); box-shadow: var(--shadow); }
        h1 { margin-bottom: 24px; text-align: center; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: var(--muted); }
        input[type="text"], input[type="file"] { width: 100%; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; outline: none; }
        input[type="text"]:focus { border-color: var(--primary); }
        .btn-create { width: 100%; background: var(--primary); color: white; border: none; padding: 14px; border-radius: 8px; font-weight: 700; cursor: pointer; transition: 0.2s; margin-top: 10px; }
        .btn-create:hover { background: #2563eb; }
        .btn-create:disabled { opacity: 0.6; cursor: not-allowed; }
        .notification { padding: 12px; border-radius: 8px; margin-bottom: 20px; text-align: center; display: none; font-size: 0.9rem; }
        .notification.error { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
        .notification.success { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
        #loadingOverlay { position: fixed; inset: 0; background: rgba(255,255,255,0.8); display: flex; align-items: center; justify-content: center; z-index: 100; font-weight: 700; }
    </style>
</head>
<body>

    <div id="loadingOverlay">Verifying Subscription...</div>

    <div class="container" id="mainContainer" style="display: none;">
        <h1>Create Your Room</h1>
        
        <div id="msg" class="notification"></div>

        <form id="createRoomForm">
            <div class="form-group">
                <label>Room Name</label>
                <input type="text" id="roomName" placeholder="Enter a unique name" required>
            </div>
            
            <div class="form-group">
                <label>Room Logo</label>
                <input type="file" id="roomLogo" accept="image/*" required>
            </div>

            <button type="submit" id="submitBtn" class="btn-create">Create Room</button>
        </form>
    </div>

    <script>
        const token = localStorage.getItem('token');
        if (!token) window.location.href = 'login.html';

        // 1. Initial Access Check
        async function checkAccess() {
            try {
                const res = await fetch('https://nodenaqd-production.up.railway.app/api/subscriptions/me', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();

                if (!res.ok || !data.allowed) {
                    window.location.href = 'subscription-status.html';
                    return;
                }

                document.getElementById('loadingOverlay').style.display = 'none';
                document.getElementById('mainContainer').style.display = 'block';

            } catch (err) {
                console.error(err);
                document.getElementById('loadingOverlay').textContent = "Error verifying status. Please refresh.";
            }
        }

        // 2. Submit Form
        document.getElementById('createRoomForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const btn = document.getElementById('submitBtn');
            const msg = document.getElementById('msg');
            const name = document.getElementById('roomName').value;
            const logo = document.getElementById('roomLogo').files[0];

            btn.disabled = true;
            msg.style.display = 'none';

            const formData = new FormData();
            formData.append('name', name);
            formData.append('logo', logo);

            try {
                const res = await fetch('https://nodenaqd-production.up.railway.app/api/rooms/create', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                    body: formData
                });

                const data = await res.json();

                if (res.ok) {
                    msg.className = 'notification success';
                    msg.textContent = 'Success! Room created. Redirecting...';
                    msg.style.display = 'block';
                    setTimeout(() => window.location.href = 'rooms.html', 1500);
                } else {
                    msg.className = 'notification error';
                    msg.textContent = data.message || 'Failed to create room';
                    msg.style.display = 'block';
                    btn.disabled = false;
                }

            } catch (err) {
                msg.className = 'notification error';
                msg.textContent = 'Server error. Please try again.';
                msg.style.display = 'block';
                btn.disabled = false;
            }
        });

        checkAccess();
    </script>
</body>
</html>