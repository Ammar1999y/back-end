import type { NavProps } from '@/components/nav';

import Home from '@/components/icons/home';
import Permissions from '@/components/icons/permissions';
import ProjectsIcon from '@/components/icons/projects';
import SectionIcon from '@/components/icons/sections';
import Setting from '@/components/icons/setting';
import User from '@/components/icons/user';

export const frontendNavData: NavProps['data'] = [
  {
    name: 'الأساسي',
    items: [
      {
        title: 'الرئيسية',
        path: '/dash',
        icon: <Home width={24} className='size-6' height={24} />,
      },

      {
        title: 'الأقسام',
        path: '/dash/sections',
        icon: <SectionIcon width={24} height={24} className='size-6' />,
        hideChildrenDropdown: true,
        children: [
          {
            title: 'إضافة قسم',
            hidden: true,
            path: '/dash/sections/new',
          },
          {
            title: 'تعديل القسم',
            hidden: true,
            path: '/dash/sections/edit',
          },
        ],
      },

      {
        title: 'إداره المشاريع',
        path: '/dash/projects',
        icon: <ProjectsIcon width={24} height={24} className='size-6' />,
        children: [
          {
            title: 'التصنيفات',
            path: '/dash/projects/categories',
            hideChildrenDropdown: true,
            children: [
              {
                title: 'إضافة تصنيف',
                hidden: true,
                path: '/dash/projects/categories/new',
              },
              {
                title: 'تعديل التصنيف',
                hidden: true,
                path: '/dash/projects/categories/edit',
              },
            ],
          },
          {
            title: 'المشاريع',
            path: '/dash/projects',
            exactMatch: true,
            hideChildrenDropdown: true,
            children: [
              {
                title: 'إضافة مشروع',
                hidden: true,
                path: '/dash/projects/new',
              },
              {
                title: 'تعديل المشروع',
                hidden: true,
                path: '/dash/projects/edit',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'الاعدادات',
    items: [
      {
        title: 'الاعدادات',
        path: '/dash/settings',
        icon: <Setting size={24} className='size-6' />,
      },
    ],
  },
  {
    name: 'الإدارة',
    items: [
      {
        title: 'المستخدمين',
        path: '/dash/users',
        icon: <User width={24} height={24} className='size-6' />,
        hideChildrenDropdown: true,
        children: [
          {
            title: 'إضافة مستخدم',
            hidden: true,
            path: '/dash/users/new',
          },
          {
            title: 'تعديل المستخدم',
            hidden: true,
            path: '/dash/users/edit',
          },
        ],
      },
      {
        title: 'الصلاحيات',
        path: '/dash/permissions',
        icon: <Permissions width={24} height={24} className='size-6' />,
        hideChildrenDropdown: true,
        children: [
          {
            title: 'إضافة صلاحية',
            hidden: true,
            path: '/dash/permissions/new',
          },
          {
            title: 'تعديل الصلاحية',
            hidden: true,
            path: '/dash/permissions/edit',
          },
        ],
      },
    ],
  },
];
