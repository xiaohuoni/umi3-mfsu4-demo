import { defineConfig } from 'umi';
import webpack from 'webpack';
import { MFSU } from './mfsu';

const mfsu = new MFSU({
    implementor: webpack as any,
    buildDepWithESBuild: false,
    depBuildConfig: {}
});

export default defineConfig({
    webpack5: {},
    devServer: {
        onBeforeSetupMiddleware(devServer) {
            for (const middleware of mfsu.getMiddlewares()) {
                devServer.app.use(middleware);
            }
        }
    },
    chainWebpack: async (memo) => {
        await mfsu.chainWebpackConfig({
            config: memo,
            depConfig: memo.toConfig()
        } as any);
        // 直接使用 extraBabelPlugins 会有执行顺序问题，所以将 babel-loader 的配置在这里重新写一次
        const bableOptions = memo.module.rules.get('js').uses.get('babel-loader').get('options');
        bableOptions.plugins = [...bableOptions.plugins, ...mfsu.getBabelPlugins()]
        memo.module
            .rule('js')
            .test(/\.(js|mjs|jsx|ts|tsx)$/)
            .include.add([
                process.cwd(),
                // import module out of cwd using APP_ROOT
                // issue: https://github.com/umijs/umi/issues/5594
                ...(process.env.APP_ROOT ? [process.cwd()] : [])
            ]).end()
            .exclude
            .add(/node_modules/)
            // don't compile mfsu temp files
            // TODO: do not hard code
            .add(/\.mfsu/)
            .end()
            .use('babel-loader')
            .loader(require.resolve('@umijs/deps/compiled/babel-loader'))
            .options(bableOptions);
        return memo;
    },
    // extraBabelPlugins: [...mfsu.getBabelPlugins()],

})