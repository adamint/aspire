const HTMLWebpackPlugin = require("html-webpack-plugin");

module.exports = (env) => {
    return {
        mode: env.NODE_ENV || "development",
        devtool: "eval-source-map",
        entry: "./src/index.js",
        devServer: {
            port: env.PORT || 4001,
            allowedHosts: "all",
            proxy: [
                {
                    context: ["/api"],
                    target:
                        process.env.services__weatherapi__https__0 ||
                        process.env.services__weatherapi__http__0,
                    pathRewrite: { "^/api": "" },
                    secure: false,
                },
                {
                    context: ["/nodeapi"],
                    target:
                        process.env.services__node_weather_api__https__0 ||
                        process.env.services__node_weather_api__http__0,
                    pathRewrite: { "^/nodeapi": "" },
                    secure: false,
                },
            ],
        },
        output: {
            path: `${__dirname}/dist`,
            filename: "bundle.js",
        },
        plugins: [
            new HTMLWebpackPlugin({
                template: "./src/index.html",
            }),
        ],
        module: {
            rules: [
                {
                    test: /\.js$/,
                    exclude: /node_modules/,
                    use: {
                        loader: "babel-loader",
                        options: {
                            presets: [
                                "@babel/preset-env",
                                ["@babel/preset-react", { runtime: "automatic" }],
                            ],
                        },
                    },
                },
                {
                    test: /\.css$/,
                    exclude: /node_modules/,
                    use: ["style-loader", "css-loader"],
                },
            ],
        },
    };
};
