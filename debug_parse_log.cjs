const fs = require('fs');
const lines = fs.readFileSync('train-goal9.log', 'utf8').split('\n').filter(Boolean);
let count = 0;
for (const line of lines) {
    if (line.includes('train iteration') || line.includes('rl retrain completed') || line.includes('promoted')) {
        try {
            const obj = JSON.parse(line);
            if (obj.message === 'train iteration') {
                process.stdout.write(`Iter ${obj.iter}: `);
                if (obj.promoted !== undefined) {
                    console.log(`promoted=${obj.promoted}, winRate=${obj.winRate}, netPnl=${obj.netPnl}`);
                } else {
                    console.log(JSON.stringify(obj.staleMetrics || {}));
                }
            } else if (obj.message === 'rl retrain completed') {
                count++;
                console.log(`RL Retrain ${count}: promoted=${obj.promoted}, winRate=${obj.inSampleWinRate}, netPnl=${obj.inSampleNetPnl}, buy=${obj.buyShare}, sell=${obj.sellShare}, hold=${obj.holdShare}, pf=${obj.inSampleProfitFactor}, reason=${obj.reason}`);
            }
        } catch (e) { }
    }
}
