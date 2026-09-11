const { fetchRearwardContext, fetchForwardContext } = require('./plugins/google_workspace.js');

async function testAll() {
    console.log("=== Testing Rearward Context ===");
    try {
        const rear = await fetchRearwardContext();
        console.log("Rearward Context Output Length:", rear.length);
        if (rear.includes("Error") || rear.includes("No credentials")) {
            console.error("FAILED REARWARD:", rear);
        } else {
            console.log("REARWARD SUCCESS!");
        }
    } catch(e) {
        console.error("REARWARD CRASH:", e);
    }
    
    console.log("\n=== Testing Forward Context ===");
    try {
        const fwd = await fetchForwardContext();
        console.log("Forward Context Output Length:", fwd.length);
        if (fwd.includes("Error") || fwd.includes("No credentials")) {
            console.error("FAILED FORWARD:", fwd);
        } else {
            console.log("FORWARD SUCCESS!");
        }
    } catch(e) {
        console.error("FORWARD CRASH:", e);
    }
}

testAll().then(() => process.exit(0));
