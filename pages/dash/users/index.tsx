import UsersPage from '@/components/users/page';

const Users = () => {
  return <UsersPage />;
};

export default Users;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/users',
      title: {
        template: 'المستخدمين',
      },
    },
  };
}
