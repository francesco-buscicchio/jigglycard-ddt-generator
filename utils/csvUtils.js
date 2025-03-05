const fs = require('fs');
const csv = require('csv-parser');

exports.parseCSV = (filePath) => {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => {
                const cleanedData = {};
                for (let key in data) {
                    const cleanKey = key.replace(/^\uFEFF/, '');
                    cleanedData[cleanKey] = data[key];
                }
                results.push(cleanedData);
            })
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
};
