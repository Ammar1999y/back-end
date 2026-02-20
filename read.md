لوحات التحكم https://antd-multipurpose-dashboard.netlify.app/dashboards/projects
https://admin.slashspaces.com/management/system/user
https://nextjs-demo.tailadmin.com/ https://shadcn-admin.netlify.app/
https://shadcnstore.com/templates/dashboard/shadcn-dashboard-landing-template/dashboard

الالوان https://www.shadcn.io/patterns/alert-dialog-destructive-4
https://ui.shadcn.com/themes

رفع ملف https://coss.com/origin/file-upload https://reui.io/docs/file-upload

الالوان https://www.shadcn.io/components/forms/color-picker
https://github.com/shadcn-ui/ui/issues/1026
https://next.jqueryscript.net/shadcn-ui/color-picker-react-colorful/
https://javascript.plainenglish.io/building-an-app-logo-builder-with-next-js-shadcn-ui-html2canvas-pro-and-lucide-icons-537debf528f7
https://github.com/Railly/shadcn-ui-customizer
https://allshadcn.com/tools/category/color-picker/
https://www.google.com/search?q=shadcn+color+picker&oq=shadcn+color&gs_lcrp=EgRlZGdlKggIAhAAGBYYHjIGCAAQRRg5MgcIARAAGIAEMggIAhAAGBYYHjIICAMQABgWGB4yCAgEEAAYFhgeMggIBRAAGBYYHjIGCAYQRRg8MgYIBxBFGEEyBggIEEUYPNIBCDU3MTBqMGoxqAIAsAIA&sourceid=chrome&ie=UTF-8

{ name: 'sys.nav.pages', items: [ // management { title: 'sys.nav.management',
path: '/management', icon: <Icon icon='local:ic-management' size='24' />,
children: [ { title: 'sys.nav.user.index', path: '/management/user', children: [
{ title: 'sys.nav.user.profile', path: '/management/user/profile', }, { title:
'sys.nav.user.account', path: '/management/user/account', }, ], }, ], }, //
menulevel { title: 'sys.nav.menulevel.index', path: '/menu_level', icon:
<Icon icon='local:ic-menulevel' size='24' />, children: [ { title:
'sys.nav.menulevel.1a', path: '/menu_level/1a', }, { title:
'sys.nav.menulevel.1b.index', path: '/menu_level/1b', children: [ { title:
'sys.nav.menulevel.1b.2a', path: '/menu_level/1b/2a', }, { title:
'sys.nav.menulevel.1b.2b.index', path: '/menu_level/1b/2b', children: [ { title:
'sys.nav.menulevel.1b.2b.3a', path: '/menu_level/1b/2b/3a', }, { title:
'sys.nav.menulevel.1b.2b.3b', path: '/menu_level/1b/2b/3b', }, ], }, ], }, ], },
// errors { title: 'sys.nav.error.index', path: '/error', icon:
<Icon icon='bxs:error-alt' size='24' />, children: [ { title:
'sys.nav.error.403', path: '/error/403', }, { title: 'sys.nav.error.404', path:
'/error/404', }, { title: 'sys.nav.error.500', path: '/error/500', }, ], }, ],
}, { name: 'sys.nav.ui', items: [ // components { title: 'sys.nav.components',
path: '/components', icon:
<Icon icon='solar:widget-5-bold-duotone' size='24' />, caption:
'sys.nav.custom_ui_components', children: [ { title: 'sys.nav.animate', path:
'/components/animate', }, { title: 'sys.nav.toast', path: '/components/toast',
}, ], }, ], }, { name: 'sys.nav.others', items: [ { title:
'sys.nav.permission.page_test', path: '/permission/page-test', icon:
<Icon icon='mingcute:safe-lock-fill' size='24' />, auth: ['permission:read'],
hidden: true, }, { title: 'sys.nav.calendar', path: '/calendar', icon:
<Icon icon='solar:calendar-bold-duotone' size='24' />, info:
<Badge variant='warning'>+12</Badge>, }, ], },
