import PermissionsPage from '@/components/permissions/page';

const Permissions = () => {
  return <PermissionsPage />;
};

export default Permissions;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/permissions',
      title: {
        template: 'الصلاحيات',
      },
    },
  };
}
