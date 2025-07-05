module.exports = {
  apps: [
    {
      name: "fbi",
      script: "index.js",
      interpreter: "node",
      watch: false,
      env: {
        NODE_ENV: "production"
      },
      // Uncomment and edit the following if you want to load env vars from a file
      // env_file: ".env"
    }
  ]
};
