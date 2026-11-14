// Only this private owned entry has a diagnostic watchdog; a user's Peer is never controlled.
const {app}=require('electron');
setTimeout(()=>app.exit(124),25000).unref();
require('./fr1-owned-main.cjs');
