/**
 * Validates that supabaseConfig.js exists and has valid configuration
 * This runs before the build to ensure the config is present
 */
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'supabaseConfig.js');

if (!fs.existsSync(configPath)) {
    console.error('ERROR: supabaseConfig.js not found!');
    console.error('Please create supabaseConfig.js with your Supabase credentials.');
    console.error('You can copy supabaseConfig.example.js and fill in your values.');
    process.exit(1);
}

// Read and validate the config
try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    
    // Check if it still has placeholder values
    if (configContent.includes('your-project-ref.supabase.co') || 
        configContent.includes('your-anon-key-here')) {
        console.error('ERROR: supabaseConfig.js still contains placeholder values!');
        console.error('Please update supabaseConfig.js with your actual Supabase credentials.');
        process.exit(1);
    }

    if (configContent.includes("CALLLOG_MASTER_KEY: 'PASTE_HERE'") ||
        configContent.includes('CALLLOG_MASTER_KEY: "PASTE_HERE"')) {
        console.error('ERROR: CALLLOG_MASTER_KEY is still the placeholder. Set a real key in supabaseConfig.js.');
        console.error('Use a Base64-encoded 32-byte value or a strong passphrase (see supabaseConfig.example.js).');
        process.exit(1);
    }
    
    // Basic validation - check for URL and key
    if (!configContent.includes('SUPABASE_URL') || !configContent.includes('SUPABASE_ANON_KEY')) {
        console.error('ERROR: supabaseConfig.js is missing required configuration!');
        process.exit(1);
    }
    
    console.log('✓ supabaseConfig.js validated successfully');
} catch (err) {
    console.error('ERROR: Failed to read supabaseConfig.js:', err.message);
    process.exit(1);
}
